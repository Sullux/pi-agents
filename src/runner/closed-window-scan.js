// #148: the CLOSED sweep refuses any window wider than ~55 days on pitcairn, because one read of the whole window is
// capped at `ISSUE_PAGE_CEILING` (500) and `listIssues` correctly calls that truncation UNKNOWN. Measured at pi-agents
// `71e314b` against `Sullux/pitcairn-portal`, `--state closed`, `--limit 500`: `closed:>=2026-10-11` (30d) -> 228 rows,
// `closed:>=2026-09-26` (45d) -> 407, `closed:>=2026-09-11` (60d) -> exactly 500 (refuses), and the same 365d window at
// `--limit 1000` -> 572 rows. Paging is NOT available on that subcommand: `gh issue list --paginate` exits 1 with
// `unknown flag: --paginate` and ZERO bytes on stdout, which a naive read reports as "no rows" rather than "the
// invocation failed". So the routes are a raised per-call limit (a cliff with a longer runway - the population grows
// ~9/day), a `gh api --paginate` read, or this: bisect the window so every slice is provably under the cap, and union.
//
// Bisection is safe on the server side because gh honors an UPPER bound, measured rather than assumed: the two-bound
// form `closed:>=2026-11-08 closed:<=2026-11-09` and the range form `closed:2026-11-08..2026-11-09` each returned 27
// rows, identical to the same window computed client-side from a lower-bound-only read (0 difference in either
// direction), and `closed:<=2026-11-08` alone produced 0 rows violating the bound. Day granularity stays a SUPERSET on
// both edges, which is exactly why the exact `closedAt` filter below is load-bearing and not a convenience.
//
// The at-cap refusal is kept, not swallowed: a slice that is still at cap below `minSliceHours` is an incident (an
// abnormal burst of closures inside twelve hours), and this answers UNKNOWN. That direction is the whole point of #85's
// rule - an unreadable read is never reported as a clean zero.
const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

// `returned exactly <n> issues on the <state> axis` is the lead `listIssues` prints when the reply length equals the
// limit it asked for (src/github/index.js, #134/#135). The shape test is pinned against the shipped source in
// test/runner/closed-window-scan.test.js so a reword reds there instead of silently disabling the bisect.
const AT_CAP_RE = /gh issue list returned exactly (\d+) issues on the (\w+) axis/

const isAtCapRefusal = (err) => {
  const message = String(err?.message ?? err ?? '')
  return AT_CAP_RE.test(message)
}

const atCapRows = (err) => {
  const m = AT_CAP_RE.exec(String(err?.message ?? err ?? ''))
  return m ? Number(m[1]) : undefined
}

// Both bounds, day-floored, UTC. The floor is a superset by design: the exact filter decides membership.
const sliceSearch = (fromMs, toMs) =>
  `closed:>=${new Date(fromMs).toISOString().slice(0, 10)} ` +
  `closed:<=${new Date(toMs).toISOString().slice(0, 10)}`

const inWindow = (row, fromMs, toMs) => {
  const t = Date.parse(row.closedAt)
  return Number.isFinite(t) && t >= fromMs && t < toMs
}

/**
 * Sweep the CLOSED axis for `windowHours` by bisecting any slice that comes back at the ceiling.
 *
 * `github.listIssues` is the only dependency, and `now` is injected so the window is testable without a clock.
 * Returns `{ readable, rows, slices, calls, truncatedAtCap, note }` - `readable: false` only when a slice could not be
 * read at all, and `note` then names the slice and the refusal it met, never a zero count.
 *
 * The runaway guard counts CALLS, not reads. A window whose every slice comes back at-cap never increments a read
 * counter, so guarding on reads bisects all the way down to the slice floor and issues hundreds of refusals - measured
 * on a 90-day window: 90d / 12h is 180 leaves, each refused, ~360 gh invocations at ~1.5s each. `maxCalls` stops that
 * and says so in the note, because a sweep that gave up partway is not a clean sweep.
 */
const scanClosedWindow = async ({
  github,
  now = Date.now,
  windowHours = 6,
  limit,
  minSliceHours = 12,
  maxCalls = 64,
} = {}) => {
  const to = now()
  const from = to - windowHours * HOUR_MS
  const optionsFor = (a, b) => {
    const search = sliceSearch(a, b)
    return limit === undefined ? { state: 'closed', search } : { state: 'closed', search, limit }
  }

  const queue = [[from, to]]
  const seen = new Map()
  const slices = []
  const errors = []
  let calls = 0
  let reads = 0
  let truncatedAtCap = false
  let stoppedByBudget = false
  const minSliceMs = minSliceHours * HOUR_MS

  while (queue.length > 0) {
    const [sliceFrom, sliceTo] = queue.shift()
    if (calls >= maxCalls) {
      errors.push(
        `bisect stopped at maxCalls (${maxCalls}) with ${queue.length} slice(s) unread - ` +
          'the window is NOT fully swept',
      )
      truncatedAtCap = true
      stoppedByBudget = true
      break
    }
    const options = optionsFor(sliceFrom, sliceTo)
    let rows
    try {
      calls += 1
      rows = await github.listIssues(options)
      // #148: a caller that returns a SHORT reply at exactly the cap is indistinguishable from a complete read here,
      // so the ceiling is the caller's to enforce - `listIssues` refuses before this line is ever reached.
    } catch (err) {
      const spanMs = sliceTo - sliceFrom
      const atCap = isAtCapRefusal(err)
      if (atCap && spanMs > minSliceMs) {
        const mid = sliceFrom + Math.floor(spanMs / 2)
        queue.push([sliceFrom, mid], [mid, sliceTo])
        slices.push({ bisected: true, from: sliceFrom, to: sliceTo, rows: atCapRows(err) })
        continue
      }
      const why = atCap
        ? `at-cap refusal (${String(atCapRows(err))} rows) on a slice of ` +
          `${Math.round(spanMs / HOUR_MS)}h, which is at or below the ${minSliceHours}h bisect floor`
        : `read failed: ${err?.message ?? err}`
      errors.push(
        `slice ${new Date(sliceFrom).toISOString()}..${new Date(sliceTo).toISOString()}: ${why} - ` +
          'this window is UNKNOWN, not clean',
      )
      truncatedAtCap = truncatedAtCap || atCap
      continue
    }
    reads += 1
    const accepted = (rows || []).filter((row) => inWindow(row, sliceFrom, sliceTo))
    // The Map key is what collapses a row that two adjacent slices both see (each slice's day floor covers it);
    // the `has` guard only preserves first-seen content, which identical rows cannot express. Key choice, not the
    // guard, is load-bearing - discrimination run reddens the union arm by keying on the slice instead.
    for (const row of accepted) if (!seen.has(row.number)) seen.set(row.number, row)
    slices.push({
      bisected: false,
      from: sliceFrom,
      to: sliceTo,
      read: (rows || []).length,
      accepted: accepted.length,
    })
  }

  const rows = [...seen.values()].sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt))
  return {
    readable: errors.length === 0,
    rows,
    scanned: rows.length,
    slices,
    reads,
    calls,
    truncatedAtCap,
    stoppedByBudget,
    windowHours,
    note:
      errors.length === 0
        ? undefined
        : `unattested-closure scan of the CLOSED axis: ${errors.join('; ')}`,
  }
}

module.exports = { scanClosedWindow, isAtCapRefusal, atCapRows, sliceSearch, DAY_MS }
