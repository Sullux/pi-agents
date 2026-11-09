const { test } = require('node:test')
const assert = require('node:assert/strict')
const { CoordService } = require('../../src/coord')
const { formatSync } = require('../../src/coord/formatters')

// #65: the hub READ path resolved independently of the WRITE path. `formatSync` took a
// `hubNumber = 4` default that `sync()` never overrode and never consulted COORD_HUB, and located
// the tail with `i.number === hubNumber || hasLabel(i, 'hub')` - so an open issue numbered 4 could
// outrank the labelled hub on list order alone, and a repo with no hub printed `== hub #4, last 5
// comments ==` over `(none)`, naming an issue that was never in the rows. Measured live at
// 2c8d005: `COORD_HUB=1157 page coord hub "x"` posted to #1157 while `COORD_HUB=1157 page coord
// sync` seconds later printed `== hub #4 ==`. These arms hold the four properties of the fix.

const row = (number, { hub = false, comments = [], title = `issue ${number}` } = {}) => ({
  number,
  title,
  body: '',
  labels: hub ? [{ name: 'hub' }] : [{ name: 'bug' }],
  comments,
})

const tailLine = (out) =>
  out.split('\n').find((l) => l.startsWith('== hub') || l.startsWith('== no hub'))

// ── the precedence arms: the box demands BOTH array orders, because the old bug was order-dependent ──

test('an open issue numbered 4 cannot outrank the labelled hub - [4, 9] order', () => {
  const out = formatSync({
    issues: [row(4), row(9, { hub: true, comments: [{ body: 'HUB-TAIL' }] })],
    currentAgent: 'foxtrot',
    repo: 'Sullux/test',
    now: Date.parse('2026-10-28T05:00:00Z'),
  })
  assert.match(
    out,
    /== hub #9 \(the 'hub' label \(formatter fallback\)\), last 5 comments ==/,
    tailLine(out),
  )
  assert.ok(!/== hub #4/.test(out), 'issue #4 is not the hub and must not be printed as one')
  assert.ok(out.includes('HUB-TAIL'), 'non-vacuity: the labelled row is the one rendered')
})

test('an open issue numbered 4 cannot outrank the labelled hub - [9, 4] order', () => {
  const out = formatSync({
    issues: [row(9, { hub: true, comments: [{ body: 'HUB-TAIL' }] }), row(4)],
    currentAgent: 'foxtrot',
    repo: 'Sullux/test',
    now: Date.parse('2026-10-28T05:00:00Z'),
  })
  assert.match(out, /== hub #9/, tailLine(out))
  assert.ok(!/== hub #4/.test(out), 'the tail must not depend on which row came first')
})

test('two labelled hubs: the LOWEST wins, not the first row - the resolver and the fallback agree', () => {
  const out = formatSync({
    issues: [row(11, { hub: true }), row(2, { hub: true, comments: [{ body: 'LOWEST-TAIL' }] })],
    currentAgent: 'foxtrot',
    repo: 'Sullux/test',
    now: Date.parse('2026-10-28T05:00:00Z'),
  })
  assert.match(out, /== hub #2/, tailLine(out))
  assert.ok(out.includes('LOWEST-TAIL'), 'non-vacuity: the #2 row is the one rendered')
})

// ── the phantom-number arms ──

test('a repo with no hub says so, names the repo, and never prints a phantom #4', () => {
  const out = formatSync({
    issues: [row(7), row(4)],
    currentAgent: 'foxtrot',
    repo: 'Sullux/pi-agents',
    now: Date.parse('2026-10-28T05:00:00Z'),
  })
  assert.match(
    out,
    /== no hub in Sullux\/pi-agents - label one open issue `hub` or set COORD_HUB/,
    tailLine(out),
  )
  assert.ok(!/== hub #4/.test(out), 'the old header named an issue that was never the hub')
  assert.ok(
    !/last 5 comments/.test(out),
    'no hub means no comments claim - the tail is skipped, not empty',
  )
})

test('a resolved hub whose row is missing reports the gap instead of serving an empty tail', () => {
  const out = formatSync({
    issues: [row(7)],
    currentAgent: 'foxtrot',
    repo: 'Sullux/test',
    hub: { number: 999, via: 'COORD_HUB=999' },
    now: Date.parse('2026-10-28T05:00:00Z'),
  })
  assert.match(out, /== hub #999 \(COORD_HUB=999\), last 5 comments ==/, tailLine(out))
  assert.match(
    out,
    /hub #999 resolved but is not among the 1 row\(s\) read/,
    'names the read size so a stale env var is diagnosable',
  )
})

// ── the service pair: one resolver feeding both paths ──

const world = ({ issues = [], kind = { isPullRequest: false }, repo = 'Sullux/test' } = {}) => {
  const posted = []
  const reads = []
  const github = {
    repo,
    issueKind: async () => kind,
    listIssues: async (options = {}) => {
      reads.push(options.state || 'all')
      return issues
    },
    commentIssue: async (num, body) => {
      posted.push({ num, body })
      return ''
    },
  }
  return {
    posted,
    reads,
    coord: CoordService({ github, agent: 'foxtrot-test', human: 'Sullux', now: () => 1700000000000 }),
  }
}

const withHub = async (value, fn) => {
  const had = Object.hasOwn(process.env, 'COORD_HUB')
  const prior = process.env.COORD_HUB
  if (value === undefined) delete process.env.COORD_HUB
  else process.env.COORD_HUB = value
  try {
    return await fn()
  } finally {
    if (had) process.env.COORD_HUB = prior
    else delete process.env.COORD_HUB
  }
}

test('COORD_HUB=an open non-hub issue: sync tail and hub() post name the SAME issue', async () => {
  const rows = [row(4, { hub: false }), row(9, { hub: true }), row(11)]
  const w = world({ issues: rows })
  await withHub('11', async () => {
    const out = await w.coord.sync()
    assert.match(out, /== hub #11 \(COORD_HUB=11\)/, tailLine(out))
    const posted = await w.coord.hub('a fleet line')
    assert.equal(posted.hubNumber, 11, 'the write path picked 11')
    assert.equal(w.posted[0].num, 11, 'and wrote there')
    const tailNumber = Number(out.match(/== hub #(\d+)/)[1])
    assert.equal(tailNumber, posted.hubNumber, 'the two paths agree - the #65 contract')
  })
})

test('sync resolves the hub from the rows it already read - exactly one listIssues call', async () => {
  const w = world({ issues: [row(9, { hub: true })] })
  await withHub(undefined, async () => {
    await w.coord.sync()
  })
  assert.equal(w.reads.length, 1, `sync must not re-read the world to find its hub: ${w.reads}`)
})

test('COORD_HUB pointing at a closed target: sync names the repo and the reason, no phantom 4', async () => {
  const w = world({ issues: [row(7)] })
  await withHub('88', async () => {
    const out = await w.coord.sync()
    assert.match(out, /== no hub in Sullux\/test/, tailLine(out))
    assert.match(
      out,
      /#88 is not an open issue here/,
      'the resolver\'s own reason is carried into the board, not swallowed',
    )
    assert.ok(!/== hub #4/.test(out), 'a bad COORD_HUB cannot resurrect the literal default')
  })
})

test('a service sync never renders the formatter fallback - one resolver feeds both paths', async () => {
  const w = world({ issues: [row(9, { hub: true })] })
  await withHub(undefined, async () => {
    const out = await w.coord.sync()
    assert.match(out, /== hub #9 \(the 'hub' label \(lowest of 1\)\)/, tailLine(out))
    assert.ok(
      !out.includes('formatter fallback'),
      'the board reached the resolver; a fallback header would mean sync passed no target',
    )
  })
})

test('a repo whose hub is numbered BELOW 4 - the reachable production case - shows #2', async () => {
  const w = world({ issues: [row(4), row(2, { hub: true, comments: [{ body: 'REAL-HUB' }] })] })
  await withHub(undefined, async () => {
    const out = await w.coord.sync()
    assert.match(out, /== hub #2 \(the 'hub' label \(lowest of 1\)\)/, tailLine(out))
    assert.ok(out.includes('REAL-HUB'), 'non-vacuity: the hub row is the one rendered')
    assert.ok(!/== hub #4/.test(out), 'the literal default must not reappear for a low hub number')
  })
})
