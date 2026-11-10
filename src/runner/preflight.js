const { isMine, cleanAgent } = require('../coord/owner')
const { tickState, closureShape } = require('../coord/tick-state')

const NON_ACTIONABLE_LABELS = [
  'hub',
  'status:claimed',
  'status:in-progress',
  'status:blocked',
  'status:in-review',
  'needs-human',
]

const isActionableUnclaimed = (issue) => {
  const labelNames = (issue.labels || []).map((l) => l.name)
  return !labelNames.some((l) => NON_ACTIONABLE_LABELS.includes(l))
}

const isPrAuthoredByAgent = (pr, agent, myOwnedIssues = []) => {
  const norm = cleanAgent(agent)
  if (!norm) return false

  const myNums = new Set(myOwnedIssues.map((i) => i.number))
  if (
    pr.closingIssuesReferences?.some((ref) => myNums.has(ref?.number || ref))
  ) {
    return true
  }

  for (const num of myNums) {
    if (
      pr.headRefName?.includes(String(num)) ||
      pr.title?.includes(`#${num}`) ||
      pr.title?.includes(`(${num})`)
    ) {
      return true
    }
  }

  if (pr.comments?.length) {
    const pat = new RegExp(
      `(?:\\(agent-${norm},?\\s*the author\\)|agent:\\s*(?:agent-)?${norm}\\s*\\(author\\))`,
      'i',
    )
    if (pr.comments.some((c) => pat.test(c.body || ''))) return true
  }

  return false
}

// #90: the verb list lives in ONE place, shared by the matcher and the gap classifier below. Two copies
// of it is how a signed PR could be called unreviewed while every arm stayed green: #87's writer and
// #87's consumer were pinned separately and never joined, and this file is the consumer.
const VERDICT_MARKERS = [
  'REVIEW',
  'RE-ATTEST',
  'APPROVE',
  'BLOCK',
  'RETRACTION',
]

// Any protocol-shaped attestation header, verdict verb or not. `**NON-SELF WITNESS for box 5** | agent:
// agent-charlie | measured at `a029d24...`` matches this and not the verb list - that is the shape the
// fleet writes on a PR thread which the matcher answers `false` about, silently.
const ATTESTATION_RE =
  /\*\*([^*]+)\*\*\s*\|\s*agent:\s*(?:agent-)?([a-z0-9-]+)/i

// The head token #89 made `coord review --pr` append, and the shape the fleet writes by hand (`| head
// \`dcc9637\``, no colon - delta's retraction, live on #84). Staleness is read ONLY from this shape: a
// verdict body quotes base SHAs and issue refs freely, and calling one of those a stale head invents a cause.
const HEAD_CITED_RE = /\bhead\b[:\s]*`?([0-9a-f]{7,40})/i

const verdictPattern = (norm) =>
  new RegExp(
    `\\*\\*(?:${VERDICT_MARKERS.join('|')})[^*]*\\*\\*\\s*\\|\\s*agent:\\s*(?:agent-)?${norm}\\b`,
    'i',
  )

const shortHead = (pr) => (pr.headRefOid ? pr.headRefOid.slice(0, 7) : '')

const namedHead = (body) => HEAD_CITED_RE.exec(body)?.[1]?.slice(0, 7) || ''

// #93: currency means the head a verdict NAMES is the head. Three sites used a bare `includes(shortSha)`, and a
// review body quotes base SHAs, issue refs and prose mentions of the new head freely, so a verdict attesting a
// DEAD head became "current" the moment anyone wrote the new sha in a sentence - which is what every reviewer on
// this fleet writes ("main moved to f3e6adf, re-measure before merging"). The prose mention is evidence about the
// conversation, not about which commit was reviewed.
//
// A verdict that names NO head keeps the substring read. That is deliberate, not leftover: pre-#89 hand-shaped
// attestations carry no token the writer produced, and requiring one would newly report a hundred correctly
// reviewed threads as unreviewed - the false-negative direction, where work vanishes off the board. Pin: the
// fallback arm in test/runner/preflight.test.js names this clause.
const verdictIsCurrent = (body, shortSha) => {
  if (!shortSha) return true
  const named = namedHead(body)
  return named ? named === shortSha : body.includes(shortSha)
}

const isPrReviewedByAgent = (pr, agent) => {
  const norm = cleanAgent(agent)
  if (!norm || !pr.comments?.length) return false

  const shortSha = shortHead(pr)
  const revPat = verdictPattern(norm)

  return pr.comments.some((c) => {
    const body = c.body || ''
    if (!revPat.test(body)) return false
    return verdictIsCurrent(body, shortSha)
  })
}

// Why did the matcher say "not reviewed by you"? `checkBacklogAvailability` turns a `false` into "go
// review this PR", and that is the right advice for an unreviewed thread and the wrong frame for every
// other cause - so the cause is named rather than the allowlist widened. The question this answers is
// "is a verdict owed on this PR?", NOT "has anyone attested here?": a one-box witness is not a verdict,
// which is why `WITNESS` is deliberately absent from VERDICT_MARKERS (#90's decision, measured off the
// caller rather than guessed). Widening would have laundered partial attestations into a reviewed state
// and dropped those PRs from the board - the false-negative direction, where work goes unseen.
const prReviewGap = (pr, agent) => {
  const norm = cleanAgent(agent)
  if (!norm)
    return {
      number: pr.number,
      gap: 'unmeasured',
      hint: 'no agent identity, so nothing is classifiable',
    }

  const shortSha = shortHead(pr)
  const bodies = (pr.comments || []).map((c) => c.body || '')
  const mine = bodies.filter((b) => verdictPattern(norm).test(b))

  if (mine.some((b) => verdictIsCurrent(b, shortSha))) {
    return { number: pr.number, gap: 'reviewed', hint: '' }
  }

  const cited = mine.map((b) => namedHead(b)).find((h) => h && h !== shortSha)
  if (cited) {
    return {
      number: pr.number,
      gap: 'stale-head-verdict',
      hint: `your verdict cites head \`${cited}\` but the head is now \`${shortSha || 'unknown'}\` - re-attest at the current head; a green measured at an old base is not evidence about this tree`,
    }
  }

  if (mine.length) {
    return {
      number: pr.number,
      gap: 'unsigned-verdict',
      hint: `your verdict on this thread carries no head token, so it cannot be matched to a commit - re-run \`page coord review <issue> --pr ${pr.number} "<verdict>"\` (#89 gives the writer that token)`,
    }
  }

  const witness = bodies
    .map((b) => ({ b, m: ATTESTATION_RE.exec(b) }))
    .find(
      ({ b, m }) =>
        m &&
        shortSha &&
        verdictIsCurrent(b, shortSha) &&
        !VERDICT_MARKERS.some((v) => m[1].toUpperCase().startsWith(v)),
    )
  if (witness) {
    return {
      number: pr.number,
      gap: 'non-verdict-attestation',
      hint: `head-cited **${witness.m[1].trim()}** by ${witness.m[2]} attests one box, not the pull request - a verdict is still owed here`,
    }
  }

  return {
    number: pr.number,
    gap: 'unreviewed',
    hint: 'no verdict on this thread yet',
  }
}

// #99: #94 stops the hand-typed `done`; this reaches the path that actually produced the six unattested
// closes - GitHub's auto-close at merge, which no guard inside the verb can be on the call path for. The
// report is deliberately population-first: a bare "0 unattested" cannot be told apart from a scan that
// read nothing, and this fleet has been burned by that shape more than once, including in a `jq` wrap
// that made a four-comment thread read as one.
const UNATTESTED_WINDOW_HOURS = 6
// #107: the read is bounded SERVER-side, because --limit cannot express a window and a repo whose whole
// closed set sits above `ISSUE_PAGE_CEILING` (pitcairn measured 553 closed at filing against a 500 cap)
// refused the sweep outright - so the guard built to catch unattested closes was blind on the one repo that
// has them. The floor is floored to a UTC DAY, which makes it always a superset of the window: the exact
// cutoff filter below still decides membership, and a day boundary is the form gh's closed:>= parses
// reliably. Raising the ceiling instead is the same cliff with a longer runway, which is why the constant is
// untouched and the at-cap refusal is kept: a truncated read is still UNKNOWN, and UNKNOWN is still honest.
const CLOSE_SCAN_LIMIT = null
const MAX_CLOSURE_LINES = 3

// The UTC-day floor of the window, as a gh search qualifier. Day granularity is deliberate: it is a
// superset, so no in-window close can be lost to rounding, and the client-side exact filter still runs.
const windowSearch = (nowMs, windowHours) =>
  `closed:>=${new Date(nowMs - windowHours * 60 * 60 * 1000).toISOString().slice(0, 10)}`

const scanUnattestedClosures = async ({
  github,
  now = Date.now,
  windowHours = UNATTESTED_WINDOW_HOURS,
  limit = CLOSE_SCAN_LIMIT,
} = {}) => {
  // an explicit `limit` of null lets listIssues apply its own ceiling; the call must not forward that key.
  // `search` is ALWAYS forwarded: it is the reason the read is small enough to be complete at all, and the
  // pin that matters is this call arriving with a value starting `closed:>=` - a bare ceiling raise leaves
  // this arm red, which is the point (a green there would say nothing about the fix).
  const search = windowSearch(now(), windowHours)
  const options =
    limit === null
      ? { state: 'closed', search }
      : { state: 'closed', search, limit }

  let closed
  try {
    closed = await github.listIssues(options)
  } catch (err) {
    // #85's rule, applied on this side of the API: an unreadable read is UNKNOWN, not clean.
    return {
      readable: false,
      scanned: 0,
      inWindow: 0,
      windowHours,
      unattested: [],
      note:
        'unattested-closure scan of the CLOSED axis: the read FAILED ' +
        `(${String(err.message || err).split('\n')[0]}) - UNKNOWN, not clean. ` +
        `the sweep asked for ${search}; an at-cap result here means the predicate was ignored or the ` +
        'window itself exceeds the ceiling, which is a different failure than a repo too big to read.',
    }
  }
  const rows = closed || []
  const cutoff = now() - windowHours * 60 * 60 * 1000
  const inWindow = rows.filter((i) => {
    const t = Date.parse(i.closedAt)
    return Number.isFinite(t) && t >= cutoff
  })
  const classified = inWindow.map((i) => ({
    number: i.number,
    closedAt: i.closedAt,
    state: tickState(i.body),
  }))
  const byNewest = (a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt)
  const unattested = classified
    .filter((r) => r.state.attestable && r.state.unticked > 0)
    .map((r) => ({
      number: r.number,
      closedAt: r.closedAt,
      ticked: r.state.ticked,
      unticked: r.state.unticked,
      boxes: r.state.boxes,
    }))
    .sort(byNewest)
  // #114: the population #99 excluded is REPORTED, not dropped. Membership of `unattested` is
  // unchanged - that is #99's ratified selectivity bar, and folding these in would accuse six
  // legitimately-issued closures of missing evidence - but a reader of "3 unattested" could not
  // previously tell "nothing was missing" from "6 of the 15 closures in the window were never
  // eligible to appear" (measured at `f3a4e04`). The `unreadable-heading` shape is the loud one: it
  // means tick boxes exist that the close guard could not see, which is a bypass rather than a style.
  const unattestable = classified
    .filter((r) => !r.state.attestable)
    .map((r) => ({
      number: r.number,
      closedAt: r.closedAt,
      shape: closureShape(r.state),
    }))
    .sort(byNewest)
  const unreadableHeadings = unattestable.filter(
    (r) => r.shape === 'unreadable-heading',
  )
  const shown = unattested.slice(0, MAX_CLOSURE_LINES)
  const dropped = unattested.length - shown.length
  const summary =
    `${rows.length} closed issue(s) scanned, ` +
    `${inWindow.length} closed within the last ${windowHours}h, ${unattested.length} unattested, ` +
    `${unattestable.length} with no tick mechanism (not gaps: #99 ratified them)`
  const list = shown
    .map(
      (s) => `#${s.number} ${s.ticked}/${s.boxes} ticked, closed ${s.closedAt}`,
    )
    .join('; ')
  const tail = dropped > 0 ? ` (+${dropped} more, newest first)` : ''
  // Appended to BOTH note branches. The bypass is precisely the state where nothing accuses: four real
  // boxes under an unreadable heading leave `unattested` empty, so a warning that rode only the
  // non-empty branch would be silent in exactly the case it exists to report (caught by the pin, not
  // by reading - the red was `#114 WARNING` missing from a note that had a tier of two in it).
  const headingWarning =
    unreadableHeadings.length > 0
      ? ` | #114 WARNING: ${unreadableHeadings.map((s) => `#${s.number}`).join(' ')} carry tick boxes under a Done-when heading the classifier cannot read, so \`coord done\` gated none of them - check those bodies before trusting their closes`
      : ''
  return {
    readable: true,
    scanned: rows.length,
    inWindow: inWindow.length,
    windowHours,
    unattested,
    unattestable,
    note:
      (unattested.length === 0
        ? `unattested-closure scan: ${summary}`
        : `unattested-closure scan: ${summary} - ${list}${tail}: these closed without anyone ticking a Done-when box, and #94's guard only covers the verb, so tick each box with its measurement or annotate why it cannot be met`) +
      headingWarning,
  }
}

const checkBacklogAvailability = async ({
  github,
  agent = '',
  now = Date.now,
}) => {
  const issues = await github.listIssues()
  const nonHubIssues = issues.filter(
    (i) => !i.labels?.some((l) => l.name === 'hub'),
  )

  if (!nonHubIssues.length) {
    return {
      status: 'idle_empty',
      reason: 'backlog_empty',
      waitSeconds: 300,
    }
  }

  // one extra read per dispatch cycle. It IS bounded, but not by limit: CLOSE_SCAN_LIMIT is null, so the fetch
  // still inherits listIssues' own ceiling, and what makes the read small enough to be complete is the
  // `closed:>=<UTC day>` predicate #110 always passes with it - the reason a repo whose whole closed set sits
  // above that ceiling can be swept at all instead of reporting UNKNOWN. What makes the report actionable is
  // still the WINDOW filter applied after the fetch, because the predicate is floored to a UTC day and is
  // therefore a superset, and an exact-hours report is the population; an unbounded report would name the
  // fleet's childhood. Runs before the branch checks below, so every state except the early-returned
  // `idle_empty` has already paid for it. The rows-at-cap refusal is kept on purpose: a day that closes at
  // least the ceiling is UNKNOWN, not clean, and UNKNOWN is the honest answer.
  const closures = await scanUnattestedClosures({ github, now })

  const allMyIssues = nonHubIssues.filter((i) => isMine(i, agent))
  const myActiveClaims = allMyIssues.filter(
    (i) => !i.labels?.some((l) => l.name === 'status:in-review'),
  )
  if (myActiveClaims.length > 0) {
    return {
      status: 'ready',
      closures,
      reason: 'owned_claims',
      count: myActiveClaims.length,
    }
  }

  const unclaimed = nonHubIssues.filter(isActionableUnclaimed)
  if (unclaimed.length > 0) {
    return {
      status: 'ready',
      closures,
      reason: 'unclaimed_tasks',
      count: unclaimed.length,
    }
  }

  const openPrs = await github.listPrs()
  const reviewablePrs = openPrs.filter(
    (pr) =>
      !isPrAuthoredByAgent(pr, agent, allMyIssues) &&
      !isPrReviewedByAgent(pr, agent),
  )

  if (reviewablePrs.length > 0) {
    // The count alone told an operator "N PRs need you" with no way to tell a signed-without-token
    // verdict from a moved head from a thread nobody has touched. Carried on the object, not rebuilt
    // by the renderer, so the advice cannot drift from the state it describes.
    return {
      status: 'ready',
      closures,
      reason: 'open_prs',
      count: reviewablePrs.length,
      reviewGaps: reviewablePrs.map((pr) => prReviewGap(pr, agent)),
    }
  }

  // #103: this path already ran the scan two lines above, so dropping the result threw away a read that was
  // paid for - and peer_contention is the one state where an agent has nothing else to do with the next 60s.
  return {
    status: 'idle_busy',
    reason: 'peer_contention',
    waitSeconds: 60,
    closures,
  }
}

module.exports = {
  checkBacklogAvailability,
  scanUnattestedClosures,
  UNATTESTED_WINDOW_HOURS,
  CLOSE_SCAN_LIMIT,
  isPrAuthoredByAgent,
  isPrReviewedByAgent,
  prReviewGap,
  VERDICT_MARKERS,
}
