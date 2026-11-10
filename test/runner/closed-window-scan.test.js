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

// #148: the claim a wide sweep must earn is COMPLETENESS - the union of the bisected leaves must equal what one
// un-truncated read of the whole window would have returned. A server-accurate fake is what makes that assertion
// non-vacuous: gh filters `closed:>=D1 closed:<=D2` at DAY granularity (measured against pitcairn: the two-bound form,
// the range form and a client-windowed lower-bound-only read each returned the same 27 rows), so every leaf reads a
// day-floor superset and the exact `closedAt` filter inside the module is what decides membership.
const MID = '2026-11-06T15:00:00Z'
const WORLD = [
  { number: 20, closedAt: '2026-11-02T10:00:00Z' }, // before `from`, but inside the floor day
  { number: 21, closedAt: '2026-11-02T20:00:00Z' },
  { number: 22, closedAt: '2026-11-04T09:00:00Z' },
  { number: 23, closedAt: MID }, // exactly the bisection mid: disjointness is decided by which half may claim it
  { number: 24, closedAt: '2026-11-09T09:00:00Z' },
  { number: 25, closedAt: '2026-11-10T10:00:00Z' },
]

const serverRead = (search) => {
  const [a, b] = search.match(/\d{4}-\d{2}-\d{2}/g)
  return WORLD.filter((r) => r.closedAt.slice(0, 10) >= a && r.closedAt.slice(0, 10) <= b)
}

const exactWindow = (fromMs, toMs) =>
  WORLD.filter((r) => Date.parse(r.closedAt) >= fromMs && Date.parse(r.closedAt) < toMs)

test('an at-cap window bisects and the union equals a single un-truncated read of the same window', async () => {
  const github = fakeGithub((options) => {
    if (dayGap(options.search) >= 5) throw atCapError()
    return serverRead(options.search)
  })
  const out = await scanClosedWindow({ github, now, windowHours: 24 * 8 })
  assert.equal(out.calls, 3, 'one refused read plus the two halves that answered it')
  assert.equal(out.slices.filter((x) => x.bisected).length, 1)
  assert.equal(out.readable, true, `unexpected note: ${out.note}`)
  const from = NOW - 24 * 8 * 3600000
  assert.deepEqual(
    out.rows.map((r) => r.number),
    exactWindow(from, NOW).map((r) => r.number).sort((x, y) => y - x),
    'the bisected union must be the whole-window answer - a leaf that lost or invented rows is the failure this fix is for',
  )
})

test('the bisected leaves are disjoint, which is why no boundary row is ever counted twice', async () => {
  const github = fakeGithub((options) => {
    if (dayGap(options.search) >= 5) throw atCapError()
    return serverRead(options.search)
  })
  const out = await scanClosedWindow({ github, now, windowHours: 24 * 8 })
  const acceptedAcrossLeaves = out.slices.filter((x) => !x.bisected).reduce((n, x) => n + x.accepted, 0)
  assert.equal(
    acceptedAcrossLeaves,
    out.rows.length,
    'a row claimed by two leaves means the halves overlap - the Map would hide it, so this asserts the partition',
  )
  assert.ok(
    out.slices.some((x) => !x.bisected && x.from === Date.parse(MID)),
    'the row at the exact mid must belong to the RIGHT half: [from, mid) then [mid, to)',
  )
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
