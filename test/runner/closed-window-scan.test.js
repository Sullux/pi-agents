const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const {
  scanClosedWindow,
  isAtCapRefusal,
  atCapRows,
  sliceSearch,
} = require('../../src/runner/closed-window-scan.js')

// #148: the CLOSED sweep must be able to complete a wide window by bisecting it, and must still answer UNKNOWN when a
// slice cannot be read. Everything here runs against a fake `github` - no arm asserts a live population count, which
// is #105's standing rule for this family (a test that memorises "572 closed issues" reds on a Tuesday and teaches
// nothing).

const NOW = Date.parse('2026-11-10T15:00:00Z')
const now = () => NOW

const atCapError = (axis = 'closed', rows = 500) =>
  new Error(
    `coord: gh issue list returned exactly ${rows} issues on the ${axis} axis for Sullux/pitcairn-portal, so the ` +
      `${axis.toUpperCase()} set is TRUNCATED and this read cannot be swept at all.`,
  )

const dayGap = (search) => {
  const [a, b] = search.match(/\d{4}-\d{2}-\d{2}/g)
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000)
}

const fakeGithub = (read) => {
  const calls = []
  return {
    calls,
    listIssues: async (options) => {
      calls.push(options)
      return read(options, calls.length)
    },
  }
}

test('a window under the cap completes in one read, forwards both bounds, and keeps the exact filter', async () => {
  const github = fakeGithub(() => [
    { number: 1, closedAt: '2026-11-09T10:00:00Z' },
    { number: 4, closedAt: '2026-11-08T00:00:00Z' },
    // day-floor superset on BOTH edges: before `from`, and after `to` inside the same UTC day.
    { number: 2, closedAt: '2026-11-07T05:00:00Z' },
    { number: 3, closedAt: '2026-11-10T20:00:00Z' },
  ])
  const out = await scanClosedWindow({ github, now, windowHours: 24 * 3 })
  assert.equal(github.calls.length, 1, 'a window that fits the ceiling must not bisect')
  assert.match(
    github.calls[0].search,
    /^closed:>=\d{4}-\d{2}-\d{2} closed:<=\d{4}-\d{2}-\d{2}$/,
    'both bounds must be sent server-side - #105 shipped the lower bound, and the upper one is what makes bisection safe',
  )
  assert.equal(github.calls[0].state, 'closed')
  assert.equal(out.readable, true, `unexpected note: ${out.note}`)
  assert.deepEqual(
    out.rows.map((r) => r.number),
    [1, 4],
    'the exact closedAt filter must drop the day-floor superset rows on both edges',
  )
  assert.equal(out.slices[0].read, 4, 'the read count is the raw reply length, not the accepted length')
})

test('an at-cap window bisects, unions without double counting, and refuses the failed call only', async () => {
  const github = fakeGithub((options) => {
    if (dayGap(options.search) >= 5) throw atCapError()
    return [
      { number: 10, closedAt: '2026-11-05T12:00:00Z' },
      // minted by BOTH halves, because each half's day floor covers it: the union must collapse it.
      { number: 11, closedAt: '2026-11-06T02:00:00Z' },
      { number: 12, closedAt: '2026-11-09T09:00:00Z' },
    ]
  })
  const out = await scanClosedWindow({ github, now, windowHours: 24 * 8 })
  assert.equal(out.calls, 3, 'one refused read plus the two halves that answered it')
  assert.equal(out.slices.filter((s) => s.bisected).length, 1)
  assert.equal(out.readable, true, `unexpected note: ${out.note}`)
  const numbers = out.rows.map((r) => r.number)
  assert.deepEqual([...new Set(numbers)].sort(), numbers.slice().sort())
  assert.equal(numbers.length, 3, `union must not double count the boundary row, got ${numbers}`)
  assert.ok(out.scanned === out.rows.length, 'scanned and rows must agree')
})

test('a slice still at cap at the bisect floor answers UNKNOWN, never a clean zero', async () => {
  const github = fakeGithub(() => {
    throw atCapError()
  })
  const out = await scanClosedWindow({ github, now, windowHours: 24 })
  assert.equal(out.readable, false, 'an un-readable window is UNKNOWN')
  assert.equal(out.truncatedAtCap, true)
  assert.ok(out.note.includes('at or below the 12h bisect floor'), out.note)
  assert.ok(out.note.includes('UNKNOWN, not clean'), out.note)
  assert.ok(/\d{4}-\d{2}-\d{2}T/.test(out.note), `the note must name the slice, got: ${out.note}`)
})

test('a non-at-cap failure is not turned into a bisect storm', async () => {
  const github = fakeGithub(() => {
    throw new Error('HTTP 502')
  })
  const out = await scanClosedWindow({ github, now, windowHours: 24 * 90 })
  assert.equal(out.calls, 1, 'a transient read failure must be reported, not multiplied into 60 gh calls')
  assert.equal(out.readable, false)
  assert.equal(out.truncatedAtCap, false, 'a 502 is not a truncation and must not be labelled one')
  assert.ok(out.note.includes('read failed: HTTP 502'), out.note)
})

test('the call budget bounds a window where every slice is at cap', async () => {
  const github = fakeGithub(() => {
    throw atCapError()
  })
  const out = await scanClosedWindow({ github, now, windowHours: 24 * 90, maxCalls: 8 })
  assert.equal(out.calls, 8, 'every call is charged, including refusals - guarding on reads alone runs away')
  assert.equal(out.readable, false)
  assert.ok(out.note.includes('stopped at maxCalls (8)'), out.note)
  assert.ok(out.note.includes('NOT fully swept'), out.note)
})

test('the at-cap classifier still matches the message the shipped client prints', () => {
  // A prose reword in src/github/index.js would otherwise leave this module bisecting nothing while every fake-driven
  // arm above stayed green - the fake never re-derives the real sentence, so the real sentence is pinned here.
  const source = readFileSync(join(__dirname, '..', '..', 'src', 'github', 'index.js'), 'utf8')
  assert.ok(
    source.includes('gh issue list returned exactly ${limit} issues on the ${state} axis'),
    'the at-cap lead moved in src/github/index.js - move AT_CAP_RE with it, or the bisect silently stops firing',
  )
  assert.ok(isAtCapRefusal(atCapError('closed')), 'the closed-axis refusal must classify')
  assert.ok(isAtCapRefusal(atCapError('open')), 'the open-axis refusal classifies too - bisection is not closed-only')
  assert.ok(isAtCapRefusal(new Error('gh issue list returned exactly 500 issues on the all axis')), 'state:all too')
  assert.equal(isAtCapRefusal(new Error('HTTP 502')), false)
  assert.equal(isAtCapRefusal(new Error('coord: gh issue list returned unreadable output for X')), false)
  assert.equal(atCapRows(atCapError('closed', 500)), 500)
  assert.equal(atCapRows(new Error('HTTP 502')), undefined)
})

test('sliceSearch floors to UTC days and is a superset of any window it bounds', () => {
  const search = sliceSearch(Date.parse('2026-11-05T23:59:59Z'), Date.parse('2026-11-06T00:00:01Z'))
  assert.equal(search, 'closed:>=2026-11-05 closed:<=2026-11-06')
  const wide = sliceSearch(NOW - 90 * 86400000, NOW)
  assert.notEqual(wide.slice(10, 20), wide.slice(-10), 'a 90-day window must carry two distinct day bounds')
})
