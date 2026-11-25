const { isMine, cleanAgent } = require('../coord/owner')
const { tickState, closureShape } = require('../coord/tick-state')
const { scanClosedWindow } = require('./closed-window-scan')

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

const BLOCK_BODY_RE =
  /^(?:REQUEST[\s_-]?CHANGES|CHANGES[\s_-]?REQUESTED|BLOCK)\b/i
const APPROVE_BODY_RE = /^APPROVE(?:D)?\b/i
const CONCUR_BLOCK_RE =
  /^CONCUR\b[^\n]*\b(?:REQUEST[\s_-]?CHANGES|CHANGES[\s_-]?REQUESTED|BLOCK)\b/i
const CONCUR_APPROVE_RE = /^CONCUR\b[^\n]*\bAPPROVE(?:D)?\b/i
const HEADER_BLOCK_RE =
  /\bverdict:\s*\*{0,2}(?:REQUEST[\s_-]?CHANGES|CHANGES[\s_-]?REQUESTED|BLOCK)\b/i
const HEADER_APPROVE_RE = /\bverdict:\s*\*{0,2}APPROVE(?:D)?\b/i

const verdictOutcome = (body, match) => {
  const headerVerb = match[1].trim().toUpperCase()
  if (headerVerb.startsWith('BLOCK')) return 'BLOCK'
  if (headerVerb.startsWith('APPROVE')) return 'APPROVE'
  if (headerVerb.startsWith('RETRACTION')) return 'RETRACTION'
  if (!VERDICT_MARKERS.some((v) => headerVerb.startsWith(v))) return ''

  const afterMatch = body.slice(match.index + match[0].length)
  const newlineIdx = afterMatch.indexOf('\n')
  const headerRest =
    newlineIdx >= 0 ? afterMatch.slice(0, newlineIdx) : afterMatch
  if (HEADER_BLOCK_RE.test(headerRest)) return 'BLOCK'
  if (HEADER_APPROVE_RE.test(headerRest)) return 'APPROVE'

  const firstBodyLine =
    newlineIdx >= 0
      ? afterMatch
          .slice(newlineIdx + 1)
          .trimStart()
          .split('\n')[0]
          .trim()
      : ''
  if (
    BLOCK_BODY_RE.test(firstBodyLine) ||
    CONCUR_BLOCK_RE.test(firstBodyLine)
  ) {
    return 'BLOCK'
  }
  if (
    APPROVE_BODY_RE.test(firstBodyLine) ||
    CONCUR_APPROVE_RE.test(firstBodyLine)
  ) {
    return 'APPROVE'
  }
  return headerVerb
}

const verdictsAtHead = (pr) => {
  const shortSha = shortHead(pr)
  const byAgent = new Map()
  for (const c of pr.comments || []) {
    const body = c.body || ''
    const match = ATTESTATION_RE.exec(body)
    if (!match || !verdictIsCurrent(body, shortSha)) continue
    const outcome = verdictOutcome(body, match)
    if (outcome) byAgent.set(match[2].toLowerCase(), outcome)
  }
  return byAgent
}

const isPrBlockedAtHead = (pr) => {
  for (const outcome of verdictsAtHead(pr).values()) {
    if (outcome === 'BLOCK') return true
  }
  return false
}

const isPrMergeReadyAtHead = (pr, agent = '') => {
  const norm = cleanAgent(agent)
  let approvals = 0
  for (const [reviewer, outcome] of verdictsAtHead(pr).entries()) {
    if (outcome === 'BLOCK' || outcome === 'RETRACTION') return false
    if (outcome === 'APPROVE' && reviewer !== norm) approvals += 1
  }
  return approvals > 0
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
// #158: how many candidates one row may probe, nearest-merge-first, looking for a body that names
// the issue as its closing target. Both live controls resolve on the first probe; the cap exists so
// a single row cannot fan out into the unbounded mention history #110 keeps this loop away from.
const CLOSER_PROBE_MAX = 3
// pi#151: an empty window read is legitimate on a quiet day and illegitimate on a blind reader, and the
// two arrive as the same []. The probe is the tie-breaker: a wide bounded sweep whose ONLY purpose is to
// prove the read can see the population at all. 90d measured 573 rows across 3 slice calls at pitcairn
// `71e314b` (the #148 header), so it stays under the bisect's own ceiling without incident.
const POPULATION_PROBE_HOURS = 24 * 90

// #161: a close with `state_reason: not_planned` is a WITHDRAWAL - a duplicate or superseded issue is
// closed precisely because the work will not happen, so its unticked Done-when boxes are true by
// definition and accusing them is unfalsifiable. The live case is pitcairn #1294: filed and closed by
// the same agent eleven minutes apart, and named in every prompt's advice line anyway, because
// membership is `attestable && unticked > 0` and no branch has ever read prose. So withdrawn closures
// leave the accusation lists and arrive as their own count.
//
// An ALLOW-LIST, never a deny-list of `completed`. The `#112` note in `src/github/index.js` records a
// real close that came back with `state_reason: null`, gh's list endpoint answers UPPERCASE where the
// REST payload answers lowercase, and an older gh that never projected the column answers `undefined`:
// so the comparison runs on a normalized token and anything unseen - `completed`, `reopened`, `null`,
// empty, a future spelling - KEEPS accusing. Inverting this is the bad failure, because a null read as
// a withdrawal hides the exact gap the sweep exists to catch.
const WITHDRAWN_REASONS = ['not_planned']

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
  // #150: this string is now only the NOTE's identity and the probe's fallback; the read itself composes
  // per-slice bounds inside `scanClosedWindow`. Kept because #135's sentence must name the window asked for.
  const search = windowSearch(now(), windowHours)

  // #150: the window read goes through `scanClosedWindow` rather than one `listIssues` call, because a
  // single read of a wide window is REFUSED at the page ceiling and the sweep had nothing to say about
  // it - #148 measured that at 90d on pitcairn: the predicate is honoured, 573 closed issues exist, and
  // `--limit 500` returns exactly 500, which is the at-cap error, not a short answer. Bisecting the
  // window turns "too wide to read" into rows. Slice failures never throw out of the scanner: it
  // collects them, so `readable: false` below is now the ONLY unreadable shape, covering both the old
  // throw path and an at-cap leaf at/below the bisect floor.
  //
  // `limit` mapping is load-bearing, not tidiness: CLOSE_SCAN_LIMIT is null, which means "let listIssues
  // apply its own ceiling", and the scanner forwards the key whenever it is not `undefined`. Passing the
  // null through would hand `gh --limit null` to the CLI, so the conversion happens here. The scanner's
  // slices carry their own upper bound (`closed:<=`), which is what makes each read small enough to be
  // complete; the whole-window `search` above is still what the note must name, because #135's
  // distinction is CLOSED-axis vs OPEN-axis and the sentence has to say which window was asked for.
  const windowOptions = limit === null ? undefined : limit
  let win
  try {
    win = await scanClosedWindow({
      github,
      now,
      windowHours,
      limit: windowOptions,
    })
  } catch (err) {
    // The scanner catches per slice, so reaching here means the seam itself is broken (a fake that
    // throws synchronously outside the read, or a shape bug). It still has to land on UNKNOWN: a sweep
    // that crashes is not a sweep that found nothing (#85's rule, unchanged in meaning).
    win = {
      readable: false,
      rows: [],
      slices: [],
      calls: 0,
      truncatedAtCap: false,
      note: `read failed before any slice completed: ${String(err?.message ?? err).split('\n')[0]}`,
    }
  }
  if (!win.readable) {
    // Stated as reads/visited slices rather than "bisected into N", because `slices` counts every slice the
    // scanner VISITED (a refused parent plus the leaves that answered), and a window that hit the floor
    // immediately visits none - `1 read across 0 visited slices` is the honest description of an at-cap
    // leaf at or below `minSliceHours`, and it is also the travel witness for this branch.
    return {
      readable: false,
      scanned: 0,
      inWindow: 0,
      windowHours,
      slices: win.slices ? win.slices.length : 0,
      calls: win.calls || 0,
      unattested: [],
      note:
        'unattested-closure scan of the CLOSED axis: UNKNOWN, not clean (pi#150). ' +
        `the sweep asked for ${search}; the window read refused after ${win.calls || 0} read(s) across ` +
        `${win.slices ? win.slices.length : 0} visited slice(s), which is a different failure than a repo ` +
        'too big to read and a different one again from the OPEN axis - an at-cap leaf means a slice at or ' +
        'below the bisect floor still cleared the page ceiling. ' +
        `${String(win.note || 'no note from the window scanner').split('\n')[0]}`,
    }
  }
  const rows = win.rows || []
  // #150: `scanned` stays what it always was - the number of rows the READS delivered - not the deduped
  // in-window union. The distinction is load-bearing and a consumer file outside this issue's scope proves
  // it: `preflight.test.js`'s "treats a row with no closedAt as outside the window" arm exists because a
  // malformed row still has to show up as a delivery, or a repo whose closures all carry bad dates reads as
  // an untested one. Counting the union instead made that arm red. Adjacent slices overlap by up to a day by
  // design (each bound is day-floored), so this sum can exceed `inWindow` - which is the same, honest
  // relationship the single read had, where the day floor widened the fetch past the window.
  const deliveries = win.slices.reduce((a, s) => a + (s.read || 0), 0)
  let witness = ''
  if (rows.length === 0) {
    const probe = await scanClosedWindow({
      github,
      now,
      windowHours: POPULATION_PROBE_HOURS,
    })
    const newest = probe.rows.reduce(
      (a, r) => Math.max(a, Date.parse(r.closedAt) || 0),
      0,
    )
    const iso = (t) => new Date(t).toISOString()
    if (!probe.readable || probe.truncatedAtCap) {
      return {
        readable: false,
        scanned: 0,
        inWindow: 0,
        windowHours,
        unattested: [],
        note:
          `unattested-closure scan of the CLOSED axis: UNKNOWN, not clean (pi#151) - the window read ` +
          `returned 0 rows AND the ${POPULATION_PROBE_HOURS / 24}d population probe could not read the ` +
          `population either${probe.truncatedAtCap ? ' (a slice stayed at the page ceiling)' : ''}: ` +
          `${String(probe.note || 'no note from the probe').split('\n')[0]}`,
      }
    }
    if (probe.rows.length === 0) {
      // #151 corrected: a COMPLETED empty probe is a quiet repo, not a blind read, and stays on the
      // clean summary path - the witness clause is what separates the two zeros from a degraded read.
      witness =
        ` (pi#151 witness: the CLOSED read completed empty and the ` +
        `${POPULATION_PROBE_HOURS / 24}d population probe completed with 0 rows - ` +
        `a genuinely quiet repo, not an unreadable one)`
    } else {
      return {
        readable: true,
        scanned: 0,
        inWindow: 0,
        windowHours,
        unattested: [],
        population: probe.rows.length,
        newestClosedAt: iso(newest),
        note:
          `unattested-closure scan: quiet window, not a blind read (pi#151) - 0 closed within the last ` +
          `${windowHours}h, and the sweep proves it can see: a ${POPULATION_PROBE_HOURS / 24}d population ` +
          `probe returned ${probe.rows.length} closed issues, newest closed ${iso(newest)}. ` +
          `Both numbers printed so 0-scanned never again reads as an untested repo.`,
      }
    }
  }
  const cutoff = now() - windowHours * 60 * 60 * 1000
  const inWindow = rows.filter((i) => {
    const t = Date.parse(i.closedAt)
    return Number.isFinite(t) && t >= cutoff
  })
  const classified = inWindow.map((i) => ({
    number: i.number,
    closedAt: i.closedAt,
    state: tickState(i.body),
    reason: `${i.stateReason ?? ''}`.trim().toLowerCase(),
  }))
  // #161: split the withdrawal population out BEFORE any accusation is derived, so it is counted
  // rather than filtered-by-absence and cannot reach either list a reader might act on. A row from a
  // caller that never learned the field lands on the accusing side, which keeps every pre-#161 fixture
  // and every older gh behaving exactly as it did before.
  const isWithdrawn = (r) => WITHDRAWN_REASONS.includes(r.reason)
  const withdrawn = classified.filter(isWithdrawn)
  const live = classified.filter((r) => !isWithdrawn(r))
  const byNewest = (a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt)
  const unattested = live
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
  const unattestable = live
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
  // #123: the sweep's prose was generated from the issue body only, so a closing PR full of ticks read
  // as "nobody attested anything" - false in two of three live cases at filing. Evidence resolution runs
  // ONLY on rows already selected for display (bounded by MAX_CLOSURE_LINES, never by the closed
  // population - #110's rule), and membership of `unattested` is unchanged: a PR body full of ticks does
  // not clear the finding, it relocates it. A failed read is `{ none: true }`, which keeps the old
  // wording for that row rather than inventing a location.
  const rowEvidence = new Map()
  for (const row of shown) {
    let evidence = { none: true }
    try {
      const closedAtMs = Date.parse(row.closedAt)
      const events = await github.issueTimeline(row.number)
      const mergeMs = (e) =>
        Date.parse(e.source?.issue?.pull_request?.merged_at ?? '')
      const mentionMs = (e) => Date.parse(e.created_at ?? '')
      // #158: rank the candidates by MERGE adjacency, not by mention recency. A cross-referenced
      // event's created_at is when the mention landed, which is not when the PR merged, so sorting
      // mentions newest-first was answering a different question than the sentence going out.
      // pitcairn #1248 is the measured shape, and note that its closer was never FILTERED OUT - the
      // old filter kept it, the old SORT ranked it third: PR #1250 mentions at 07:15:47 and merges at
      // 10:03:59Z, two seconds before the 10:04:01Z close, while the innocent PR #1245 mentions LATER
      // at 08:30:26Z (merged 09:11, 53 minutes earlier) - so newest-mention picked #1245, whose body
      // has no tick section at all (0/0), and the sweep accused a 4/4 closure of "0/4 ticked".
      // #1226 is the control that says this is not a re-roll of the same dice: nearest-merge-before
      // close there is #1227, which newest-mention also happened to pick, so #147's credited row
      // survives untouched. merged_at rides in the same event already in hand, so the fix costs no
      // extra calls; an UNMERGED PR has merged_at null, and NaN drops it here - a PR that never
      // merged cannot have caused a close, whatever it mentioned.
      const nearest = []
      for (const e of events || []) {
        const t = mergeMs(e)
        const m = mentionMs(e)
        if (
          e.event !== 'cross-referenced' ||
          !e.source?.issue?.pull_request ||
          // BOTH windows, deliberately intersected rather than swapped. The mention-predates-close test
          // is #147's and is NOT relaxed: a cross-reference that lands after the close is someone
          // talking about a finished issue, and letting merged_at alone decide would admit it as
          // evidence - a new false-credit surface, which is the direction #99/#110 exist to avoid
          // (an accusation that disappears is worse than one that persists). merged_at is then ADDED,
          // which strictly shrinks the set too: pitcairn #1226's PR #1219 mentions 03:46:15 (inside the
          // old window) yet merges 04:08:34, AFTER the 04:03:14Z close, so the old rule could have
          // ranked a never-causal merge first had its mention been the latest.
          !Number.isFinite(m) ||
          m > closedAtMs ||
          !Number.isFinite(t) ||
          t > closedAtMs
        )
          continue
        const at = nearest.findIndex((c) => c.pr === e.source.issue.number)
        if (at === -1) nearest.push({ pr: e.source.issue.number, mergedMs: t })
        else if (t > nearest[at].mergedMs) nearest[at].mergedMs = t
      }
      nearest.sort((a, b) => b.mergedMs - a.mergedMs)
      // Walk nearest-first but STOP at the first body that names this issue as its closing target -
      // GitHub's own auto-close trigger, so it is the strongest claim of causation available without
      // a new API surface, and it keeps both live controls at exactly one pullRequest() call. The
      // walk is capped because a row's candidate list is unbounded (#110's rule): ten PRs mentioning
      // one issue must not turn a three-row sweep into thirty calls.
      const namedCloser = new RegExp(
        `\\b(?:clos(?:e|es|ed|ing)|fix(?:e[sd]?|es|d)?|resolv(?:e|es|ed|ing))\\b[^\\n]{0,60}#\\s*${row.number}\\b`,
        'i',
      )
      let picked = null
      for (const c of nearest.slice(0, CLOSER_PROBE_MAX)) {
        const pr = await github.pullRequest(c.pr)
        const st = tickState(pr.body || '')
        const probe = {
          pr: c.pr,
          mergedAt: pr.mergedAt,
          ticked: st.ticked,
          boxes: st.boxes,
          hasSection: st.hasSection,
          named: namedCloser.test(pr.body || ''),
        }
        if (!picked) picked = probe
        if (probe.named) {
          picked = probe
          break
        }
      }
      if (picked)
        evidence = {
          pr: picked.pr,
          ticked: picked.ticked,
          boxes: picked.boxes,
          hasSection: picked.hasSection,
          named: picked.named,
          mergedAt: picked.mergedAt,
        }
    } catch {
      evidence = { none: true }
    }
    rowEvidence.set(row.number, evidence)
  }
  const unattestedWithEvidence = unattested.map((row) => ({
    ...row,
    evidence: rowEvidence.get(row.number) || { none: true, unscanned: true },
  }))
  // #150: a wide window is no longer one read, so the note says how many slices it took. Counted as the
  // slices that ANSWERED (`!bisected`), not everything visited, so "swept in 2 slice(s) over 3 call(s)" reads
  // true: three reads went out, one of them refused. Only printed when the window actually bisected, so
  // every existing note assertion for the default 6h sweep is byte-identical - the arm below that pins the
  // flat sentence is the guard that this clause is conditional.
  const leaves = win.slices.filter((s) => !s.bisected).length
  const swept =
    win.slices.length > 1
      ? ` (swept in ${leaves} slice(s) over ${win.calls} call(s), pi#150)`
      : ''
  const summary =
    `${deliveries} closed issue(s) scanned${swept}, ` +
    witness +
    `${inWindow.length} closed within the last ${windowHours}h, ${unattested.length} unattested, ` +
    `${unattestable.length} with no tick mechanism (not gaps: #99 ratified them), ` +
    // #151's rule, applied to a population this change filters: a filtered-zero names what it
    // filtered, so "0 unattested" can never again be read as "nothing was missing" when the window
    // was in fact full of withdrawals.
    `${withdrawn.length} withdrawn (not_planned), not accused (#161)`
  const list = shown
    .map((s) => {
      const ev = rowEvidence.get(s.number) || { none: true }
      // #158 box 5: three states, three sentences. "found a closing PR and its body has no tick
      // section" and "no PR merged before this close at all" both reported boxes === 0 and printed
      // the SAME bare "0/N ticked" line, so a reader could not tell that evidence was looked for and
      // absent from that it was looked for and could not be located. pitcairn #1242 is the live third
      // state: all five of its candidates merged AFTER its 06:47:54Z close, so nothing resolved.
      return ev.pr && ev.boxes > 0
        ? `#${s.number} ${s.ticked}/${s.boxes} in the issue body, ${ev.ticked}/${ev.boxes} in PR #${ev.pr} - port them into the issue body, ticks are what the sweep counts (#161)`
        : ev.pr
          ? `#${s.number} ${s.ticked}/${s.boxes} ticked, closed ${s.closedAt} (PR #${ev.pr} resolves as the closer at merge ${ev.mergedAt} but its body ${ev.hasSection ? 'has a Done-when section with nothing ticked' : 'carries no Done-when section at all'} - the ticks are not in any closing PR)`
          : `#${s.number} ${s.ticked}/${s.boxes} ticked, closed ${s.closedAt} (no closing PR found: no PR mentioning this issue merged before the close, so it was closed by hand, by a coord done verb, or by a raw commit - the issue body is the only evidence)`
    })
    .join('; ')
  const anyPrEvidence = shown.some((s) => {
    const ev = rowEvidence.get(s.number) || {}
    return Boolean(ev.pr && ev.boxes > 0)
  })
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
    scanned: deliveries,
    inWindow: inWindow.length,
    windowHours,
    slices: win.slices.length,
    calls: win.calls,
    unattested: unattestedWithEvidence,
    unattestable,
    note:
      (unattested.length === 0
        ? `unattested-closure scan: ${summary}`
        : `unattested-closure scan: ${summary} - ${list}${tail}: ${
            anyPrEvidence
              ? 'for the rows above the closing PR body carries the ticks the sweep could not see in the issue - port them into the issue body, because membership counts ticks and an annotation alone keeps this line firing by design (#161)'
              : "these closed without anyone ticking a Done-when box, and #94's guard only covers the verb, so tick each box with its measurement; a duplicate or superseded issue belongs closed as `not_planned`, which this sweep suppresses (#161), and prose alone will not clear this line"
          }`) + headingWarning,
  }
}

const checkBacklogAvailability = async ({
  github,
  agent = '',
  now = Date.now,
}) => {
  const issues = await github.listIssues({
    state: 'open',
    fields: 'number,labels,comments',
  })
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

  let cachedPrs
  const getOpenPrs = async () => {
    if (!cachedPrs) cachedPrs = (await github.listPrs?.()) || []
    return cachedPrs
  }

  const allMyIssues = nonHubIssues.filter((i) => isMine(i, agent))
  const openPrsForClaims = allMyIssues.length > 0 ? await getOpenPrs() : []
  const myActiveClaims = allMyIssues.filter((issue) => {
    const authoredPrs = openPrsForClaims.filter((pr) =>
      isPrAuthoredByAgent(pr, agent, [issue]),
    )
    if (authoredPrs.some(isPrBlockedAtHead)) return true
    if (issue.labels?.some((l) => l.name === 'status:in-review')) return false
    return authoredPrs.length === 0
  })
  if (myActiveClaims.length > 0) {
    const closures = await scanUnattestedClosures({ github, now })
    return {
      status: 'ready',
      closures,
      reason: 'owned_claims',
      count: myActiveClaims.length,
    }
  }

  const unclaimed = nonHubIssues.filter(isActionableUnclaimed)
  if (unclaimed.length > 0) {
    const closures = await scanUnattestedClosures({ github, now })
    return {
      status: 'ready',
      closures,
      reason: 'unclaimed_tasks',
      count: unclaimed.length,
    }
  }

  const openPrs = await getOpenPrs()
  const reviewablePrs = openPrs.filter(
    (pr) =>
      !isPrAuthoredByAgent(pr, agent, allMyIssues) &&
      !isPrReviewedByAgent(pr, agent),
  )

  if (reviewablePrs.length > 0) {
    const closures = await scanUnattestedClosures({ github, now })
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

  const mergeReadyPrs = openPrs.filter(
    (pr) =>
      isPrAuthoredByAgent(pr, agent, allMyIssues) &&
      isPrMergeReadyAtHead(pr, agent),
  )

  if (mergeReadyPrs.length > 0) {
    const closures = await scanUnattestedClosures({ github, now })
    return {
      status: 'ready',
      closures,
      reason: 'merge_ready_prs',
      count: mergeReadyPrs.length,
      mergeReadyPrs: mergeReadyPrs.map((pr) => pr.number),
    }
  }

  return {
    status: 'idle_busy',
    reason: 'peer_contention',
    waitSeconds: 60,
  }
}

module.exports = {
  checkBacklogAvailability,
  scanUnattestedClosures,
  UNATTESTED_WINDOW_HOURS,
  CLOSE_SCAN_LIMIT,
  isPrAuthoredByAgent,
  isPrMergeReadyAtHead,
  isPrReviewedByAgent,
  prReviewGap,
  VERDICT_MARKERS,
}
