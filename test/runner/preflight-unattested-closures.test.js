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
