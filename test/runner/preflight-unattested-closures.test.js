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
  // non-vacuity: the read seam must have been traveled, or every arm below passes on a mock that never ran
  assert.equal(calls.length, 1, 'the scan never called listIssues')
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
  const floor = Date.parse(calls[0].search.slice('closed:>='.length))
  assert.ok(
    Number.isFinite(floor),
    `search floor is not a parseable date: ${calls[0].search}`,
  )
  assert.equal(
    calls[0].search,
    `closed:>=${new Date(FIXED_NOW - 6 * HOUR).toISOString().slice(0, 10)}`,
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
  const { result } = await scanDriven(
    async (options) => {
      await c.listIssues(options)
      return []
    },
    { windowHours: 6 },
  )
  assert.equal(result.readable, true)
  const list = argv[argv.length - 1]
  assert.ok(
    list.includes('--search'),
    `no --search reached gh: ${list.join(' ')}`,
  )
  assert.equal(
    list[list.indexOf('--search') + 1],
    `closed:>=${new Date(FIXED_NOW - 6 * HOUR).toISOString().slice(0, 10)}`,
  )
  assert.ok(list.includes('closed'), 'the read lost its state')
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

const xrefEvent = (prNumber, at = '2026-11-10T01:59:00Z') =>
  JSON.stringify({
    event: 'cross-referenced',
    created_at: at,
    source: { issue: { number: prNumber, pull_request: {} } },
  })

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
