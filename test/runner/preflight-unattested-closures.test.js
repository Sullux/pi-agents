const { it } = require('node:test')
const assert = require('node:assert/strict')
const { scanUnattestedClosures } = require('../../src/runner/preflight')

// #107: the guard built to catch closed-but-unattested work read NOTHING at pitcairn and reported a clean
// board, because the sweep asked `gh` for the whole closed set (553 at filing, against a 500 ceiling) and the
// at-cap refusal is the only truncation signal a list can give. The fix is a server-side window, so every arm
// here is about the READ, never about a live count.
//
// That constraint is not stylistic. The in-window population is a property of the INSTANT you sample it:
// measured on a 30-row set, `in6h` went 15 -> 14 in three and a half minutes because the sliding cutoff passed
// one issue's `closedAt` - the data did not move, the cutoff did. A pin of the form "the windowed read returns
// N rows" therefore flakes on the fleet's own merge cadence, so `now` is frozen here and the only live number
// in this file is the argv floor: at least six issues close a day on this fleet (pitcairn measured +1 during
// the writing of #107 alone), so a `closed:>=` predicate can never legitimately be empty.
const FIXED_NOW = Date.parse('2026-11-10T03:00:00.000Z')
const HOUR = 60 * 60 * 1000

const body = (ticked, unticked) =>
  [
    '## Goal',
    'x',
    '',
    '## Done when',
    ...Array.from({ length: ticked }, (_, i) => `- [x] done ${i}`),
    ...Array.from({ length: unticked }, (_, i) => `- [ ] open ${i}`),
  ].join('\n')

const scanDriven = async (rows, options = {}) => {
  const calls = []
  const github = {
    listIssues: async (o) => {
      calls.push(o)
      if (typeof rows === 'function') return rows(o)
      return rows
    },
  }
  const result = await scanUnattestedClosures({
    github,
    now: () => FIXED_NOW,
    ...options,
  })
  // non-vacuity: the read seam must have been traveled, or every arm below passes on a mock that never ran.
  // pi#151 loosened the exact-1 to >=1 because the empty-window arms legitimately fire the population probe,
  // which drives more listIssues calls; the window call remains calls[0] in every arm, and the probe's own
  // seam floors are asserted per-arm.
  assert.ok(calls.length >= 1, 'the scan never called listIssues')
  return { result, calls }
}

it('the closed read is bounded server-side: options.search starts with the closed:>= qualifier', async () => {
  const { calls } = await scanDriven([])
  const options = calls[0]
  assert.equal(
    options.state,
    'closed',
    'the sweep did not ask for the closed axis',
  )
  assert.ok(
    typeof options.search === 'string' &&
      options.search.startsWith('closed:>='),
    `expected a closed:>= predicate, got ${JSON.stringify(options.search)} - raising ISSUE_PAGE_CEILING ` +
      'without a window satisfies every count and sweeps nothing durably, which is what this arm refuses to allow',
  )
})

it('the search floor is a UTC day floored BELOW the cutoff, so the window is never under-read', async () => {
  const { calls } = await scanDriven([], { windowHours: 6 })
  // #150: the window read is now a SLICE read, so its search carries an upper bound as well. The
  // invariant this arm was written to hold is untouched - the server-side floor must never sit above the
  // cutoff - it just has to be read off the lower half of the predicate now. Asserting the upper bound is
  // NEW, and it is the stronger half: the per-slice ceiling is the thing that makes a read small enough
  // to be complete, so dropping it would re-open the at-cap refusal this whole lane exists to close.
  const lower = calls[0].search.split(' closed:<=')[0]
  const floor = Date.parse(lower.slice('closed:>='.length))
  assert.ok(
    Number.isFinite(floor),
    `search floor is not a parseable date: ${calls[0].search}`,
  )
  assert.equal(
    lower,
    `closed:>=${new Date(FIXED_NOW - 6 * HOUR).toISOString().slice(0, 10)}`,
  )
  assert.ok(
    calls[0].search.includes(' closed:<='),
    `the slice read lost its upper bound, so the window is unbounded again: ${calls[0].search}`,
  )
  const cutoff = FIXED_NOW - 6 * HOUR
  assert.ok(
    floor <= cutoff,
    'the server floor is ABOVE the cutoff, so in-window closes would be lost',
  )
  assert.ok(
    cutoff - floor < 24 * HOUR,
    'the floor is more than a day of slack ahead of the cutoff',
  )
})

it('an explicit limit still forwards, and the search travels with it', async () => {
  const { calls } = await scanDriven([], { limit: 40 })
  assert.equal(calls[0].limit, 40)
  assert.ok(
    String(calls[0].search).startsWith('closed:>='),
    'the limit arm dropped the predicate',
  )
})

it('limit is not forwarded when it is null: the ceiling belongs to the client', async () => {
  const { calls } = await scanDriven([], { limit: null })
  assert.ok(
    !('limit' in calls[0]),
    `limit key reached the read: ${JSON.stringify(calls[0])}`,
  )
})

it('a windowed read that clears the cap makes the scan readable and still accuses', async () => {
  const rows = [
    {
      number: 1207,
      closedAt: new Date(FIXED_NOW - 1 * HOUR).toISOString(),
      body: body(0, 8),
    },
    {
      number: 1193,
      closedAt: new Date(FIXED_NOW - 5 * HOUR).toISOString(),
      body: body(0, 4),
    },
    {
      number: 1170,
      closedAt: new Date(FIXED_NOW - 20 * HOUR).toISOString(),
      body: body(0, 6),
    },
    {
      number: 1201,
      closedAt: new Date(FIXED_NOW - 2 * HOUR).toISOString(),
      body: body(3, 3),
    },
  ]
  const { result } = await scanDriven(rows)
  assert.equal(
    result.readable,
    true,
    `the scan refused a read it could complete: ${result.note}`,
  )
  assert.equal(
    result.inWindow,
    3,
    'the day floor widened the CLIENT-side window',
  )
  assert.deepEqual(
    result.unattested.map((u) => u.number),
    [1207, 1201, 1193],
  )
  assert.equal(result.scanned, 4)
})

it('an at-cap read is UNKNOWN, not clean - and the note names the window it asked for', async () => {
  // The live way to reach this arm is gone: a 6h window at pitcairn is 0.2-6% of the ceiling, so the
  // measurement is a fake github fed exactly-limit rows (echo's point - the attestation must say so rather
  // than citing a live run). What is NOT simulated is the refusal's own axis wording, pinned against the real
  // client in test/github/issue-list-ceiling.test.js.
  const { result } = await scanDriven(() => {
    throw new Error(
      'coord: gh issue list returned exactly 500 issues on the closed axis, so the CLOSED set is TRUNCATED',
    )
  })
  assert.equal(result.readable, false)
  assert.equal(result.scanned, 0)
  assert.deepEqual(result.unattested, [])
  assert.match(result.note, /UNKNOWN, not clean/)
  assert.ok(
    result.note.includes('closed:>='),
    `the note does not name the window asked for: ${result.note}`,
  )
})

it('the sweep really reaches gh with the predicate: an argv pin through the execFile seam', async () => {
  const { GitHubClient } = require('../../src/github')
  const argv = []
  const c = GitHubClient({
    execFile: (cmd, args) => {
      argv.push([cmd, ...args])
      return '[]'
    },
    repo: 'Sullux/pitcairn-portal',
  })
  // #150: every read the sweep makes now goes through the scanner, so the short-circuit fake that used to
  // protect this arm from probe slices is obsolete - and obsolete in the useful direction. What has to
  // stay true is that a REAL gh invocation carries a window predicate, which is the reason a wide window
  // stopped being refused. Asserted over EVERY list call rather than the last one: a bare ceiling raise
  // would still pass a single-call check if any later read went out unbounded.
  const { result } = await scanDriven((o) => c.listIssues(o).then(() => []), {
    windowHours: 6,
  })
  assert.equal(result.readable, true)
  const lists = argv.filter((a) => a.includes('list'))
  assert.ok(lists.length >= 1, `no gh list invocation reached the seam`)
  for (const list of lists) {
    assert.ok(
      list.includes('--search'),
      `a read went out with no predicate at all: ${list.join(' ')}`,
    )
    assert.ok(
      list[list.indexOf('--search') + 1].startsWith('closed:>='),
      `the predicate is not a window floor: ${list.join(' ')}`,
    )
  }
  const first = lists[0]
  assert.equal(
    first[first.indexOf('--search') + 1].split(' ')[0],
    `closed:>=${new Date(FIXED_NOW - 6 * HOUR).toISOString().slice(0, 10)}`,
  )
  assert.ok(first.includes('closed'), 'the read lost its state')
})

// #114: #99 ratified that box-less closures are not gaps, and that decision is preserved exactly here -
// `unattested` membership does not move. What changed is the silence around it: the report used to say
// "3 unattested" about a 15-closure window in which 6 were never eligible to appear, and a reader could
// not tell an empty window from a dropped one.
const shapes = {
  unattested: body(0, 8),
  attested: body(5, 0),
  numbered: '## Done when\n1. first\n2. second\n',
  plainBullets: '## Done when\n- first\n- second\n',
  noWhenSection: '## Goal\nnothing that reads as a gate\n',
  unreadableHeading: '## Done-when\n- [ ] a\n- [ ] b\n',
}

const rowsFor = (keys) =>
  keys.map((k, i) => ({
    number: 700 + i,
    closedAt: new Date(FIXED_NOW - (i + 1) * HOUR).toISOString(),
    body: shapes[k],
  }))

it('the box-less tier is reported alongside, without moving unattested membership', async () => {
  const keys = [
    'unattested',
    'attested',
    'numbered',
    'plainBullets',
    'noWhenSection',
    'unreadableHeading',
  ]
  const { result } = await scanDriven(rowsFor(keys))
  assert.equal(result.readable, true)
  assert.deepEqual(
    result.unattested.map((s) => s.number),
    [700],
    'only the checkbox shape may accuse - #99 selectivity bar, unedited',
  )
  assert.deepEqual(
    result.unattestable.map((s) => [s.number, s.shape]),
    [
      [702, 'numbered'],
      [703, 'plain-bullets'],
      [704, 'no-when-section'],
      [705, 'unreadable-heading'],
    ],
    `the excluded population must be enumerable by reason: ${JSON.stringify(result.unattestable)}`,
  )
  // the fully-ticked issue is in neither list: it attested itself, and folding it in would read as noise
  assert.ok(
    !result.unattestable.some((s) => s.number === 701),
    'an attested close belongs to no tier',
  )
  assert.match(result.note, /1 unattested/)
  assert.match(
    result.note,
    /4 with no tick mechanism/,
    `the note reports the count it dropped: ${result.note}`,
  )
})

it('the note stays quiet about the warning when no heading is unreadable', async () => {
  const { result } = await scanDriven(
    rowsFor(['unattested', 'numbered', 'plainBullets', 'noWhenSection']),
  )
  assert.equal(result.unattestable.length, 3, 'the tier itself still reports')
  assert.ok(
    !result.note.includes('#114 WARNING'),
    `a warning with nothing to warn about: ${result.note}`,
  )
})

// The loud half, and the reason this tier is not merely bookkeeping: `coord done` refuses on
// `attestable && unticked > 0`, so four real boxes under an unreadable heading gate nothing at all and
// used to attest themselves clean as `unattested: 0/0`.
it('the warning names the unreadable-heading issue and no other', async () => {
  const { result } = await scanDriven(
    rowsFor(['numbered', 'unreadableHeading']),
  )
  assert.ok(
    result.note.includes('#114 WARNING'),
    `the bypass case reported nothing: ${result.note}`,
  )
  assert.ok(
    result.note.includes('#701'),
    `the warning did not name the offender: ${result.note}`,
  )
  assert.ok(
    !result.note.includes('#700'),
    'a legitimately numbered closure must not be accused by the warning',
  )
})

// #123: the sweep's accusation was issue-body-only prose; two of its three live refutations were closes
// whose ticks sit in the CLOSING PR's body. These arms pin the evidence chain, its bounds, and the two
// renderings - never a live population count (in-window figures move; #114 box 4 and #1209's 0/8->8/8).
const closedRow = (number, ticked, unticked) => ({
  number,
  closedAt: '2026-11-10T02:00:00Z',
  body: body(ticked, unticked),
  title: `x${number}`,
  labels: [],
  comments: [],
})

const xrefEvent = (
  prNumber,
  at = '2026-11-10T01:59:00Z',
  mergedAt = '2026-11-10T01:59:30Z',
) =>
  JSON.stringify({
    event: 'cross-referenced',
    created_at: at,
    // #158: `merged_at` is a REAL field of this payload (source.issue.pull_request.merged_at) and the
    // picker now ranks on it, so the fixture has to carry it. A helper that left it out would make
    // every candidate unrankable and the `none` arms below would pass for the wrong reason - a
    // vacuous green wearing a real assertion, which is how a fixture hides a pin (#833's class).
    source: {
      issue: { number: prNumber, pull_request: { merged_at: mergedAt } },
    },
  })

// a body that names the issue as its closing target: GitHub's own auto-close trigger, and the
// strongest claim of causation available without a new API surface
const closerBody = (n, ticked) => `${body(ticked, 0)}

Closes #${n}`
// a body with no Done-when section whatsoever, which must read differently from "no closer found"
const sectionlessBody = '## Goal\n\nsome prose, no boxes anywhere'

const scanWithEvidence = async (rows, { timeline = [], pullRequest } = {}) => {
  const state = { listCalls: 0, timelineCalls: [], prCalls: [] }
  const github = {
    listIssues: async () => {
      state.listCalls += 1
      return rows
    },
    issueTimeline: async (n) => {
      state.timelineCalls.push(n)
      if (typeof timeline === 'function') return timeline(n)
      return timeline.map((line) => JSON.parse(line))
    },
    pullRequest: async (n) => {
      state.prCalls.push(n)
      if (pullRequest) return pullRequest(n)
      return { number: n, mergedAt: '2026-11-10T02:00:01Z', body: body(2, 0) }
    },
  }
  const result = await scanUnattestedClosures({ github, now: () => FIXED_NOW })
  return { result, state }
}

it('#123 evidence: a closing PR full of ticks relocates the accusation, per-row and aggregate', async () => {
  const { result, state } = await scanWithEvidence([closedRow(777, 0, 2)], {
    timeline: [xrefEvent(778)],
  })
  assert.equal(
    state.timelineCalls.length,
    1,
    'the selected row must travel the timeline seam',
  )
  assert.deepEqual(
    {
      pr: result.unattested[0].evidence.pr,
      ticked: result.unattested[0].evidence.ticked,
    },
    { pr: 778, ticked: 2 },
  )
  assert.ok(
    result.note.includes(
      '#777 0/2 in the issue body, 2/2 in PR #778 - port the ticks or annotate why each box cannot be met',
    ),
    `the pr-case rendering is absent: ${result.note}`,
  )
  assert.ok(
    !result.note.includes(
      'these closed without anyone ticking a Done-when box',
    ),
    'the false human-behavior claim survived while the tree says the ticks exist',
  )
})

it('#123 the none case keeps the old wording, and a cross-reference AFTER the close is not evidence', async () => {
  const clean = await scanWithEvidence([closedRow(777, 0, 2)], { timeline: [] })
  assert.ok(
    clean.result.note.includes(
      'these closed without anyone ticking a Done-when box',
    ),
  )
  assert.equal(clean.result.unattested[0].evidence.none, true)
  const late = await scanWithEvidence([closedRow(777, 0, 2)], {
    timeline: [xrefEvent(778, '2026-11-10T02:00:02Z')],
  })
  assert.equal(
    late.result.unattested[0].evidence.none,
    true,
    'a post-close xref cannot be its evidence',
  )
  assert.equal(
    late.state.prCalls.length,
    0,
    'the late candidate must not cost a PR read',
  )
})

it('#123 membership is UNCHANGED: identical numbers with and without the evidence reads', async () => {
  const corpus = [
    closedRow(777, 0, 2),
    closedRow(779, 1, 1),
    closedRow(781, 0, 3),
  ]
  const withEv = await scanWithEvidence(corpus, { timeline: [xrefEvent(778)] })
  const blind = await scanWithEvidence(corpus, {
    timeline: () => {
      throw new Error('timeline unavailable')
    },
  })
  assert.deepEqual(
    withEv.result.unattested.map((r) => r.number),
    blind.result.unattested.map((r) => r.number),
  )
  assert.equal(
    blind.result.unattested[0].evidence.none,
    true,
    'a failed read suppresses, never invents',
  )
})

it('#123 cost: zero flagged rows make zero timeline calls; five flagged cost at most MAX_CLOSURE_LINES', async () => {
  const clean = await scanWithEvidence([closedRow(777, 5, 0)], { timeline: [] })
  assert.equal(
    clean.state.timelineCalls.length,
    0,
    'an unused seam must stay untouched on a clean board',
  )
  assert.equal(clean.result.unattested.length, 0)
  const many = await scanWithEvidence(
    [1, 2, 3, 4, 5].map((n) => closedRow(700 + n, 0, 1)),
    { timeline: [] },
  )
  assert.equal(
    many.state.timelineCalls.length,
    3,
    'reads are bounded by displayed rows, not the closed set',
  )
  assert.ok(
    many.result.note.includes('+2 more, newest first'),
    many.result.note,
  )
})

it('#123 dropped rows carry unscanned evidence, so prose never claims a location it did not read', async () => {
  const many = await scanWithEvidence(
    [1, 2, 3, 4].map((n) => closedRow(700 + n, 0, 1)),
    { timeline: [] },
  )
  const droppedRow = many.result.unattested[3]
  assert.equal(droppedRow.evidence.none, true)
  assert.equal(droppedRow.evidence.unscanned, true)
})

// pi#151: an empty window read must never print as a clean sweep. The window call is the single-bound
// `closed:>=` search; the population probe is the two-bound slice form from closed-window-scan. Arms route
// by that shape because both go through the same injected listIssues seam.
const probeRows = (rows) => (o) =>
  o.search && o.search.includes(' closed:<=') ? rows : []

it('#151 a zero window inside a readable population reports QUIET with both numbers printed, not a flat zero', async () => {
  const { result, calls } = await scanDriven(
    probeRows([{ number: 99, closedAt: '2026-11-07T10:00:00.000Z' }]),
  )
  assert.equal(result.readable, true)
  assert.ok(result.note.includes('quiet window, not a blind read'), result.note)
  assert.ok(result.note.includes('1 closed issues'), result.note)
  assert.ok(result.note.includes('2026-11-07'), result.note)
  assert.ok(
    calls.length >= 2,
    `probe seam never traveled: ${calls.length} calls`,
  )
})

it('#151 a COMPLETED empty probe keeps the clean summary and prints its witness - corrected goal, box 2 the other way', async () => {
  const { result, calls } = await scanDriven(probeRows([]))
  assert.equal(result.readable, true)
  assert.ok(result.note.includes('closed issue(s) scanned'), result.note)
  assert.ok(
    result.note.includes('population probe completed with 0 rows'),
    result.note,
  )
  assert.ok(
    !result.note.includes('UNKNOWN'),
    `a completed zero must not alarm: ${result.note}`,
  )
  assert.ok(
    calls.length >= 2,
    `probe seam never traveled: ${calls.length} calls`,
  )
})

it('#151 a probe stuck at the page ceiling is UNKNOWN, never a clean quiet claim', async () => {
  const atCap = async (o) => {
    // #150 changes which read is which: the sweep's OWN window call now carries ` closed:<=`, so that
    // token can no longer mean "this is the probe". The discriminator is the SPAN - the population probe
    // asks for 90 days, the default window asks for 6 - which keeps this arm testing what #151 built it
    // to test: a window read that COMPLETES EMPTY against a population the probe cannot read.
    const m = /closed:>=(\S+) closed:<=(\S+)/.exec(o.search || '')
    const wideSpan =
      m && Date.parse(m[2]) - Date.parse(m[1]) > 24 * 60 * 60 * 1000
    if (wideSpan) {
      throw new Error(
        'gh issue list returned exactly 500 issues on the closed axis',
      )
    }
    return []
  }
  const { result } = await scanDriven(atCap)
  assert.equal(result.readable, false)
  assert.ok(
    result.note.includes('population probe could not read the population'),
    result.note,
  )
})

it('#151 plausibility: a closed_at beyond now is filtered by the probe itself and lands in the same clean-witness branch', async () => {
  const future = probeRows([
    {
      number: 5,
      closedAt: new Date(FIXED_NOW + 24 * HOUR).toISOString(),
    },
  ])
  const { result } = await scanDriven(future)
  // scanClosedWindow's own slice filter (`t >= from && t < to`) drops a future row, which lands the
  // probe at 0 rows - the plausibility guard the Goal asks for is therefore the two-zeros refusal, and
  // an unreachable `newest > now` branch in preflight would be a lie in the source.
  assert.equal(result.readable, true)
  assert.ok(
    result.note.includes('population probe completed with 0 rows'),
    result.note,
  )
})

it('#151 rows with unparseable closed_at are filtered by the probe itself and land in completed-empty', async () => {
  const { result } = await scanDriven(
    probeRows([{ number: 7, closedAt: 'not-a-date' }]),
  )
  assert.equal(result.readable, true)
  assert.ok(
    result.note.includes('population probe completed with 0 rows'),
    result.note,
  )
})

it('#151 non-vacuity pair: a non-empty window read never fires the probe at all', async () => {
  const { result, calls } = await scanDriven([closedRow(120, 2, 0)])
  assert.equal(
    calls.length,
    1,
    `probe fired on a populated window: ${calls.length} calls`,
  )
  assert.ok(result.note.includes('closed issue(s) scanned'), result.note)
})

// #158: the sweep resolves a closure by MERGE adjacency now, because a cross-referenced event's
// created_at is the mention time and is uncorrelated with the merge - measured on pitcairn #1248,
// whose closer PR #1250 mentions at 07:15:47 but merges at 10:03:59, two seconds before the close,
// while the innocent PR #1245 mentions LATER (08:30:26) and merged 53 minutes earlier.
it('#158 ranks by merge adjacency, so the closer wins over the latest mention (pitcairn #1248)', async () => {
  const innocent = 1245
  const closer = 1250
  const { result, state } = await scanWithEvidence([closedRow(777, 0, 4)], {
    timeline: [
      // the innocent one is the LATEST mention before the close, which is what the old sort picked
      xrefEvent(innocent, '2026-11-10T01:59:50Z', '2026-11-10T01:30:00Z'),
      // the closer mentions EARLIER but merges nearest to the close
      xrefEvent(closer, '2026-11-10T01:50:00Z', '2026-11-10T01:59:59Z'),
    ],
    pullRequest: (n) =>
      n === closer
        ? {
            number: n,
            mergedAt: '2026-11-10T01:59:59Z',
            body: closerBody(777, 4),
          }
        : {
            number: n,
            mergedAt: '2026-11-10T01:30:00Z',
            body: sectionlessBody,
          },
  })
  assert.equal(
    result.unattested[0].evidence.pr,
    closer,
    'a later MENTION must not outrank a nearer MERGE - the old rule returned the innocent PR',
  )
  assert.equal(
    state.prCalls.length,
    1,
    `the named-closer short-circuit never traveled: ${state.prCalls}`,
  )
  assert.deepEqual(
    state.prCalls,
    [closer],
    'the nearest-merge candidate must be probed first',
  )
  assert.ok(
    result.note.includes(
      '#777 0/4 in the issue body, 4/4 in PR #1250 - port the ticks or annotate why each box cannot be met',
    ),
    `the credited rendering is absent: ${result.note}`,
  )
})

it("#158 control: where both rules agree, #147's credited row is byte-identical (pitcairn #1226)", async () => {
  const { result, state } = await scanWithEvidence([closedRow(777, 0, 5)], {
    timeline: [xrefEvent(1227, '2026-11-10T01:55:00Z', '2026-11-10T01:59:30Z')],
    pullRequest: () => ({
      number: 1227,
      mergedAt: '2026-11-10T01:59:30Z',
      body: closerBody(777, 5),
    }),
  })
  assert.equal(result.unattested[0].evidence.pr, 1227)
  assert.equal(
    state.prCalls.length,
    1,
    'the control must not fan out into extra calls',
  )
  assert.ok(
    result.note.includes(
      '#777 0/5 in the issue body, 5/5 in PR #1227 - port the ticks or annotate why each box cannot be met',
    ),
    `#147's sentence changed under the ranking fix: ${result.note}`,
  )
})

it("#158 a merge AFTER the close is not a closer even when its mention predates it (#1226's PR #1219 shape)", async () => {
  const { result, state } = await scanWithEvidence([closedRow(777, 0, 2)], {
    // mention 01:59 is INSIDE the old window, merge 02:00:05 is after the 02:00:00 close
    timeline: [xrefEvent(1219, '2026-11-10T01:59:00Z', '2026-11-10T02:00:05Z')],
  })
  assert.equal(
    result.unattested[0].evidence.none,
    true,
    'a PR that merged after the close cannot have caused it, whatever it mentioned',
  )
  assert.deepEqual(
    state.prCalls,
    [],
    'the excluded candidate must never reach a pullRequest call',
  )
})

it('#158 an unmerged PR (merged_at null) is never a closer', async () => {
  const { result } = await scanWithEvidence([closedRow(777, 0, 2)], {
    timeline: [xrefEvent(900, '2026-11-10T01:59:00Z', null)],
  })
  assert.equal(result.unattested[0].evidence.none, true)
})

it('#158 three states, three sentences: a sectionless closer is not "no closer found"', async () => {
  const resolved = await scanWithEvidence([closedRow(777, 0, 2)], {
    timeline: [xrefEvent(800, '2026-11-10T01:59:00Z', '2026-11-10T01:59:30Z')],
    pullRequest: () => ({
      number: 800,
      mergedAt: '2026-11-10T01:59:30Z',
      body: sectionlessBody,
    }),
  })
  const missing = await scanWithEvidence([closedRow(777, 0, 2)], {
    timeline: [],
  })
  assert.ok(
    resolved.result.note.includes('resolves as the closer at merge'),
    `the resolved-but-sectionless sentence is absent: ${resolved.result.note}`,
  )
  assert.ok(
    resolved.result.note.includes('carries no Done-when section at all'),
    resolved.result.note,
  )
  assert.ok(
    missing.result.note.includes('no closing PR found'),
    `the no-closer sentence is absent: ${missing.result.note}`,
  )
  assert.ok(
    !missing.result.note.includes('resolves as the closer'),
    'the two states collapsed back into one wording',
  )
  assert.ok(
    !resolved.result.note.includes('no closing PR found'),
    'the two states collapsed back into one wording (other direction)',
  )
  assert.equal(missing.result.unattested[0].evidence.none, true)
})

it('#158 a closer whose section has no boxes reads differently from having no section at all', async () => {
  // tickState says boxes 0 / hasSection TRUE for a `## Done when` heading with prose under it, and
  // boxes 0 / hasSection FALSE for a body with no such heading. Both reach the ev.pr branch (boxes is
  // not > 0, so the credited form cannot fire), and the whole point of box 5 is that a reader can tell
  // them apart. A fixture of body(0, 3) would NOT test this: three unticked boxes is boxes > 0, which
  // routes to the credited sentence - the first draft of this arm did exactly that and passed nothing.
  const emptySection = await scanWithEvidence([closedRow(777, 0, 2)], {
    timeline: [xrefEvent(801, '2026-11-10T01:59:00Z', '2026-11-10T01:59:30Z')],
    pullRequest: () => ({
      number: 801,
      mergedAt: '2026-11-10T01:59:30Z',
      body: '## Done when\n\nplain prose, nothing checkbox-shaped',
    }),
  })
  assert.ok(
    emptySection.result.note.includes(
      'has a Done-when section with nothing ticked',
    ),
    emptySection.result.note,
  )
  assert.ok(
    !emptySection.result.note.includes('carries no Done-when section at all'),
    emptySection.result.note,
  )
  const boxesPresent = await scanWithEvidence([closedRow(777, 0, 2)], {
    timeline: [xrefEvent(802, '2026-11-10T01:59:00Z', '2026-11-10T01:59:30Z')],
    pullRequest: () => ({
      number: 802,
      mergedAt: '2026-11-10T01:59:30Z',
      body: body(0, 3),
    }),
  })
  assert.ok(
    boxesPresent.result.note.includes('0/3 in PR #802'),
    `three unticked boxes in the closer must still be credited where they are: ${boxesPresent.result.note}`,
  )
})

it('#158 the walk continues past a nearer merge that does not name the issue', async () => {
  const { result, state } = await scanWithEvidence([closedRow(777, 0, 2)], {
    timeline: [
      xrefEvent(900, '2026-11-10T01:59:00Z', '2026-11-10T01:59:40Z'),
      xrefEvent(901, '2026-11-10T01:40:00Z', '2026-11-10T01:40:30Z'),
    ],
    pullRequest: (n) =>
      n === 901
        ? {
            number: n,
            mergedAt: '2026-11-10T01:40:30Z',
            body: closerBody(777, 2),
          }
        : {
            number: n,
            mergedAt: '2026-11-10T01:59:40Z',
            body: sectionlessBody,
          },
  })
  assert.equal(
    result.unattested[0].evidence.pr,
    901,
    'a body that names the issue as its closing target outranks a nearer merge that does not',
  )
  assert.deepEqual(
    state.prCalls,
    [900, 901],
    `the walk order is wrong: ${state.prCalls}`,
  )
})

it('#158 the probe is capped, so one row cannot fan out into the whole mention history', async () => {
  const many = Array.from({ length: 6 }, (_, i) =>
    xrefEvent(
      700 + i,
      '2026-11-10T01:00:00Z',
      `2026-11-10T01:${String(30 + i).padStart(2, '0')}:00Z`,
    ),
  )
  const { result, state } = await scanWithEvidence([closedRow(777, 0, 2)], {
    timeline: many,
    pullRequest: (n) => ({
      number: n,
      mergedAt: '2026-11-10T01:59:00Z',
      body: sectionlessBody,
    }),
  })
  assert.equal(
    state.prCalls.length,
    3,
    `CLOSER_PROBE_MAX is not bounding the walk: ${state.prCalls}`,
  )
  assert.equal(
    result.unattested[0].evidence.pr,
    705,
    'within the cap the nearest merge must still win',
  )
})

// ---------------------------------------------------------------------------
// pi#150: the CLOSED sweep reads its window through `scanClosedWindow`.
//
// Box 4 lives here as a COMMENT, because the live 90-day driver must stay outside the suite: a population
// count measured from `Sullux/pitcairn-portal` is a fact about a moving repo, and pinning one would make
// main red the next time anybody closes an issue. The driver is /tmp/bravo-150-live.cjs (real GitHubClient,
// not a fake) and the measurement it produced on 2026-11-21T18:59:39Z at head `dc960d0`. That sha is not this
// PR's tip (amends moved it), so the claim is stated where it can be checked: `src/runner/preflight.js` is
// byte-identical from `dc960d0` to the shipped head - `git diff --numstat dc960d0 HEAD -- src/runner/preflight.js`
// is empty - and only comments differ in this file, so the live reading describes the code this PR ships.
// A/B in one run, against `Sullux/pitcairn-portal`:
//   A. the pre-wiring route, one listIssues read of `closed:>=<90d floor>` -> THREW after 26.2 s:
//      "coord: gh issue list returned exactly 500 issues on the closed axis for Sullux/pitcairn-portal".
//   B. the wired sweep, same window -> { readable: true, scanned: 581, inWindow: 581, slices: 3, calls: 3,
//      unattested: 228, unattestable: 97 } in 55.2 s, note carrying "swept in 2 slice(s) over 3 call(s)".
// A is the defect #148 measured and #150 exists to close; B is the same request answered with rows. Both
// numbers are dated observations about a live board, not assertions - nothing below reads them.
//
// One design note, because it cost a red in a file this issue does not declare: my first wiring made
// `scanned` the deduped in-window union, which is where the scanner now drops the day-floor slack. That
// broke `test/runner/preflight.test.js`'s "treats a row with no closedAt as outside the window" arm, whose
// own comment says the scanned number MUST survive a delivery that is not window membership - so `scanned`
// is deliveries (sum of the reads that answered), unchanged, and the arm at the end of this file pins that
// the slack row still counts as a scan while staying out of the accused set.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000

// A fake that behaves like `gh issue list` on the closed axis instead of like a stub: it honours BOTH
// day-floored bounds of the search string, and refuses with the at-cap error when its own answer would
// clear the page ceiling. #150 cannot be tested against a fake that ignores `closed:<=` - the first slice
// would swallow the whole window, the bisect would never happen, and a green arm would prove nothing about
// the split it claims to exercise.
const ghLike = (population, { cap = Infinity } = {}) => {
  const log = []
  return {
    log,
    listIssues: async (o) => {
      const m = /closed:>=(\S+)(?: closed:<=(\S+))?/.exec(o.search || '')
      if (!m) throw new Error('the read lost its closed:>= predicate entirely')
      const from = Date.parse(m[1])
      // `closed:<=DAY` is inclusive of that whole UTC day, which is exactly why adjacent slices overlap by
      // up to a day and the scanner's dedup Map is load-bearing rather than defensive.
      const to = m[2] ? Date.parse(m[2]) + DAY : from + DAY
      const hit = population
        .filter((r) => {
          const t = Date.parse(r.closedAt)
          return Number.isFinite(t) && t >= from && t < to
        })
        .sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt))
      log.push({ search: o.search, returned: hit.length })
      if (hit.length >= cap) {
        throw new Error(
          `gh issue list returned exactly ${hit.length} issues on the closed axis`,
        )
      }
      return hit
    },
    listPrs: async () => [],
    viewPr: async () => null,
    viewIssue: async () => null,
  }
}

const sweepWith = async (github, options = {}) => {
  const result = await scanUnattestedClosures({
    github,
    now: () => FIXED_NOW,
    ...options,
  })
  assert.ok(
    github.log.length >= 1,
    'the sweep never reached the read seam, so nothing below was measured',
  )
  return { result, log: github.log }
}

const NINETY_DAYS = 2160

it('#150 an at-cap leaf at or below the bisect floor makes the SWEEP report UNKNOWN, closed-axis worded (#135 survives)', async () => {
  // Every read refuses, including the first 6h slice - which is already narrower than the scanner's
  // minSliceHours floor, so the bisection has nowhere to go and the leaf IS the floor. This is the state
  // #135 was written about: the sweep must say UNKNOWN about the CLOSED axis, must not print a clean zero,
  // and must not borrow the OPEN-axis accusation that belongs to the scope gate.
  const fake = ghLike([], { cap: 0 })
  const { result } = await sweepWith(fake)
  assert.equal(
    result.readable,
    false,
    'an unreadable window must never report a clean sweep',
  )
  assert.equal(result.scanned, 0)
  assert.deepEqual(result.unattested, [])
  assert.ok(
    !/\b0 unattested\b/.test(result.note),
    `a failed read printed a clean count: ${result.note}`,
  )
  assert.match(result.note, /UNKNOWN, not clean/)
  assert.ok(result.note.includes('CLOSED axis'), result.note)
  assert.ok(
    result.note.includes('closed:>='),
    'the note must still name the window it asked for',
  )
  assert.ok(
    result.note.includes('bisect floor'),
    `the closed-axis at-cap wording is missing, so this reads like the #135 open-axis refusal: ${result.note}`,
  )
  // The two shapes #135 keeps apart. The OPEN sentence belongs to `src/github/index.js` and to the scope
  // gate's collision set; a closure sweep has neither, and emitting it would send a reader hunting a
  // ceiling raise that is not the problem.
  assert.ok(!result.note.includes('OPEN set is TRUNCATED'), result.note)
  assert.ok(!result.note.includes('invisible to the scope gate'), result.note)
  // non-vacuity: the refusal has to have TRAVELED the seam, not merely been asserted about it. At 6h the
  // first slice is already below the 12h bisect floor, so the scanner must make exactly one read and VISIT
  // zero slices - the signature of stopping AT the floor rather than bisecting down to it. The scanner's own
  // diagnostic (carried into the note) is what proves the at-cap branch ran.
  assert.equal(
    result.calls,
    1,
    `expected one read at the floor, got ${result.calls}`,
  )
  assert.equal(
    result.slices,
    0,
    'a slice below the floor cannot bisect, so nothing should be visited',
  )
  assert.ok(
    result.note.includes('on a slice of 6h'),
    `the window scanner's own diagnostic is missing, so this note may be prose rather than a measurement: ${result.note}`,
  )
})

it('#150 a wide window that refuses the first read yields the SAME rows as one un-truncated read', async () => {
  // The differential IS the assertion. Hand-written expectations would only prove the bisect is stable;
  // comparing a bisected sweep against a single complete read of the same population proves the split
  // neither lost nor duplicated a close - which is the whole claim of the wiring.
  const population = [1, 2, 3, 4, 5, 6].map((n) => ({
    number: 3000 + n,
    closedAt: new Date(FIXED_NOW - n * 14 * DAY).toISOString(),
    body: body(n % 2 === 0 ? 4 : 0, 4),
  }))
  const whole = await sweepWith(ghLike(population), {
    windowHours: NINETY_DAYS,
  })
  const split = await sweepWith(ghLike(population, { cap: 4 }), {
    windowHours: NINETY_DAYS,
  })

  assert.equal(whole.result.readable, true, whole.result.note)
  assert.equal(
    whole.result.slices,
    1,
    'the unbounded population must be one read, or the baseline is not a baseline',
  )
  // the baseline itself has to carry signal, or two empty lists would agree vacuously
  assert.equal(whole.result.scanned, 6)
  assert.ok(
    whole.result.unattested.length >= 1,
    'the fixture produced no accusation to compare',
  )

  assert.equal(
    split.result.readable,
    true,
    `the bisected sweep refused: ${split.result.note}`,
  )
  assert.equal(
    split.result.calls,
    3,
    'expected one refusal plus both halves answered',
  )
  // `slices` counts everything VISITED - the refused parent plus the two leaves - so 3 here is the honest
  // number and the note, which counts only the slices that ANSWERED, says 2. Pinned together on purpose:
  // if the two ever disagree about the same run, one of them is lying to the reader.
  assert.equal(split.result.slices, 3, 'one refused parent plus two leaves')
  assert.ok(
    split.result.note.includes('swept in 2 slice(s) over 3 call(s)'),
    `the note miscounts the sweep: ${split.result.note}`,
  )
  assert.equal(
    split.result.scanned,
    whole.result.scanned,
    'the split lost or duplicated a close',
  )
  assert.equal(split.result.inWindow, whole.result.inWindow)
  assert.deepEqual(
    split.result.unattested.map((u) => u.number),
    whole.result.unattested.map((u) => u.number),
    'the accused set changed between one read and three',
  )
  // and the refusal actually happened - otherwise this arm is just the baseline twice
  assert.equal(
    split.log[0].returned,
    6,
    'the first read was not at cap, so no bisection was forced and this pair proves nothing',
  )
})

it('#150 the slice diagnostic is conditional, so the flat 6h summary sentence stays byte-identical', async () => {
  const quiet = await sweepWith(ghLike([]), { windowHours: 6 })
  assert.ok(
    !quiet.result.note.includes('swept in'),
    `a window that never bisected printed slice counts: ${quiet.result.note}`,
  )
  const population = [1, 2, 3, 4, 5, 6].map((n) => ({
    number: 4000 + n,
    closedAt: new Date(FIXED_NOW - n * 14 * DAY).toISOString(),
    body: body(4, 4),
  }))
  const split = await sweepWith(ghLike(population, { cap: 4 }), {
    windowHours: NINETY_DAYS,
  })
  assert.ok(
    split.result.note.includes('swept in 2 slice(s) over 3 call(s)'),
    `the bisect is invisible in the note: ${split.result.note}`,
  )
})

it('#150 a 6h window costs exactly one read, and day-floor slack still counts as a delivery', async () => {
  // The non-vacuity half of the wiring for the narrow case: a window narrower than the bisect floor must go
  // out as ONE slice read (if it bisected, every "scanned" number below would be a sum of reads, not a read),
  // and it must still report the 4 rows the read DELIVERED while claiming only 3 as window members. That gap
  // is the day floor doing its job, and it is the same relationship the single read had - #150 did not move
  // it. `1319` is the slack row: 20h old, so outside the 6h window but inside `closed:>=<floored day>`.
  const rows = [
    {
      number: 1307,
      closedAt: new Date(FIXED_NOW - 1 * HOUR).toISOString(),
      body: body(0, 4),
    },
    {
      number: 1301,
      closedAt: new Date(FIXED_NOW - 5 * HOUR).toISOString(),
      body: body(0, 4),
    },
    {
      number: 1311,
      closedAt: new Date(FIXED_NOW - 2 * HOUR).toISOString(),
      body: body(4, 4),
    },
    {
      number: 1319,
      closedAt: new Date(FIXED_NOW - 20 * HOUR).toISOString(),
      body: body(0, 4),
    },
  ]
  const { result } = await sweepWith(ghLike(rows), { windowHours: 6 })
  assert.equal(result.slices, 1, 'a 6h window must not bisect')
  assert.equal(result.calls, 1, `expected one read, got ${result.calls}`)
  assert.equal(
    result.scanned,
    4,
    'every delivered row counts as a scan, in window or not',
  )
  assert.equal(
    result.inWindow,
    3,
    'the slack row must not be claimed as a window member',
  )
  // 1319 was DELIVERED (it is in `scanned`) and is still not accused, because it is not a window member -
  // which is the exact separation this arm exists to hold. The three in-window rows all appear: a body with
  // every box ticked is still unattested until the ticks reach the closing PR (#99's rule), so this is not a
  // "ticked rows drop out" assertion, it is a "window membership decides the accused set" assertion.
  assert.deepEqual(
    result.unattested.map((u) => u.number),
    [1307, 1311, 1301],
    'the accused set must be exactly the in-window rows, newest close first',
  )
  assert.ok(
    !result.unattested.some((u) => u.number === 1319),
    'the slack row was counted as a delivery and must NOT be accused',
  )
})
