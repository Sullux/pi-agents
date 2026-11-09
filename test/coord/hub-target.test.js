const { test } = require('node:test')
const assert = require('node:assert/strict')
const { CoordService } = require('../../src/coord')

// #53: `hub` resolved its target as `Number(process.env.COORD_HUB || 4)` - a literal issue
// number with no label lookup and no existence, kind, or state check. Measured symptom: a
// run printed `Posted to hub #4 @Sullux/pitcairn-portal` with rc=0 while the 3,977-byte body
// landed on Sullux/pi-agents issue #4, which is the closed ENOBUFS bug report. These arms
// hold the three properties the fix turns on: the target comes from the repo, the target is
// verified, and the repo in the success value is the repo that was written to.

const world = ({
  issues = [],
  kind = { isPullRequest: false },
  repo = 'Sullux/pi-agents',
  listable = true,
} = {}) => {
  const posted = []
  const reads = []
  const github = {
    repo,
    issueKind: async () => kind,
    commentIssue: async (num, body) => posted.push({ num, body }),
  }
  if (listable) {
    github.listIssues = async (options = {}) => {
      reads.push(options.state || 'open')
      return issues
    }
  }
  return {
    posted,
    reads,
    coord: CoordService({
      github,
      agent: 'foxtrot-test',
      human: 'Sullux',
      now: () => 1700000000000,
    }),
  }
}

const hubbed = (number) => ({ number, labels: [{ name: 'hub' }] })
const plain = (number) => ({ number, labels: [{ name: 'bug' }] })

// COORD_HUB is process-global, so every arm that touches it restores it in a finally -
// otherwise a later arm inherits a declared hub and passes for the wrong reason.
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

test('no hub label and no COORD_HUB: refuses, and names the repo and the label', async () => {
  const w = world({ issues: [plain(4), plain(7)] })
  const res = await withHub(undefined, () => w.coord.hub('starting the wave'))
  assert.equal(res.ok, false)
  assert.match(res.error, /no open issue carries the 'hub' label/)
  assert.match(
    res.error,
    /in Sullux\/pi-agents/,
    'the refusal names where it looked',
  )
  assert.match(res.error, /nothing was posted/)
  assert.equal(w.posted.length, 0, 'a refusal must not reach commentIssue')
})

test('the literal 4 default is gone: an unlabelled open issue #4 is not a hub', async () => {
  const w = world({ issues: [plain(4)] })
  const res = await withHub(undefined, () => w.coord.hub('a note'))
  assert.equal(
    res.ok,
    false,
    'falling back to #4 is the exact bug this issue filed',
  )
  assert.equal(w.posted.length, 0)
})

test('COORD_HUB names an open issue and the SYNC lands there', async () => {
  const w = world({ issues: [plain(9), plain(4)] })
  const res = await withHub('9', () => w.coord.hub('wave two merged'))
  assert.equal(res.ok, true, res.error)
  assert.equal(res.hubNumber, 9)
  assert.equal(w.posted[0].num, 9)
  assert.match(w.posted[0].body, /^\*\*SYNC\*\*/)
})

test('COORD_HUB outranks the label when both are present', async () => {
  const w = world({ issues: [plain(9), hubbed(4)] })
  const res = await withHub('9', () => w.coord.hub('explicit wins'))
  assert.equal(
    res.hubNumber,
    9,
    'an explicit declaration is the author editing the target',
  )
})

test('with no COORD_HUB the single hub-labelled issue is the target', async () => {
  const w = world({ issues: [plain(4), hubbed(12)] })
  const res = await withHub(undefined, () => w.coord.hub('label lookup'))
  assert.equal(res.ok, true, res.error)
  assert.equal(res.hubNumber, 12)
  assert.equal(res.via, "the 'hub' label (lowest of 1)")
})

test('COORD_HUB pointing at a pull request is refused before the POST', async () => {
  const w = world({ issues: [], kind: { isPullRequest: true } })
  const res = await withHub('55', () => w.coord.hub('into a PR'))
  assert.equal(res.ok, false)
  assert.match(res.error, /is a pull request, not an issue/)
  assert.equal(w.posted.length, 0)
})

test('COORD_HUB pointing at a closed issue is refused (it is not in the open list)', async () => {
  const w = world({ issues: [plain(7)] })
  const res = await withHub('4', () => w.coord.hub('into a closed thread'))
  assert.equal(res.ok, false)
  assert.match(res.error, /#4 is not an open issue here/)
  assert.equal(w.posted.length, 0)
})

test('a whitespace-only COORD_HUB is unset, not issue 0 (the old default produced 0)', async () => {
  // `Number(process.env.COORD_HUB || 4)` turned `COORD_HUB='  '` into hubNumber 0, because a
  // blank string is truthy - so the verb used to post a fleet report at a nonexistent issue.
  const w = world({ issues: [hubbed(4)] })
  const res = await withHub('  ', () => w.coord.hub('blank is not zero'))
  assert.equal(res.ok, true, res.error)
  assert.equal(res.hubNumber, 4, 'falls through to the label lookup')
  assert.equal(res.via, "the 'hub' label (lowest of 1)")
})

test('COORD_HUB that is not an issue number is refused as such', async () => {
  for (const bad of ['abc', '0', '-3', '2.5']) {
    const w = world({ issues: [hubbed(4)] })
    const res = await withHub(bad, () => w.coord.hub('bad target'))
    assert.equal(
      res.ok,
      false,
      `COORD_HUB=${JSON.stringify(bad)} must not post`,
    )
    assert.match(res.error, /is not a positive integer issue number/)
    assert.equal(w.posted.length, 0)
  }
})

test('two hub-labelled issues: the LOWEST wins, even from a shuffled list (the documented rule)', async () => {
  // SKILL.md: `COORD_HUB` when set, else the lowest-numbered open issue labelled `hub`.
  // Sorting is what makes two agents' runs agree, so the arm feeds an unsorted list.
  const w = world({ issues: [hubbed(30), hubbed(4), hubbed(12)] })
  const res = await withHub(undefined, () => w.coord.hub('crowded hub'))
  assert.equal(res.ok, true, res.error)
  assert.equal(res.hubNumber, 4, 'lowest-numbered, not first-in-list')
  assert.equal(res.via, "the 'hub' label (lowest of 3)")
  assert.equal(w.posted[0].num, 4)
})

test('a labelled row with an unusable number is skipped, not posted to', async () => {
  const w = world({
    issues: [{ number: 'abc', labels: [{ name: 'hub' }] }, hubbed(9)],
  })
  const res = await withHub(undefined, () => w.coord.hub('junk row'))
  assert.equal(res.ok, true, res.error)
  assert.equal(res.hubNumber, 9)
})

test('labelled rows that are ALL unusable refuse rather than posting to junk', async () => {
  const w = world({
    issues: [plain(4), { number: 0, labels: [{ name: 'hub' }] }],
  })
  const res = await withHub(undefined, () => w.coord.hub('no usable hub'))
  assert.equal(res.ok, false)
  assert.match(res.error, /none has a usable issue number/)
  assert.equal(w.posted.length, 0)
})
test('a client that cannot list refuses instead of assuming a target', async () => {
  const w = world({ listable: false })
  const res = await withHub(undefined, () => w.coord.hub('unverifiable repo'))
  assert.equal(
    res.ok,
    false,
    'no TypeError, no post - an unverifiable repo is a refusal',
  )
  assert.equal(w.posted.length, 0)
})

test('the success value names the repo the write actually went through', async () => {
  const w = world({ issues: [hubbed(4)], repo: 'Sullux/pi-agents' })
  const res = await withHub(undefined, () => w.coord.hub('witness'))
  assert.equal(res.ok, true, res.error)
  assert.equal(
    res.repo,
    'Sullux/pi-agents',
    'the printed repo must come from the client that posted, not a sibling instance',
  )
  assert.equal(w.posted.length, 1)
})

test('a message the guards reject costs no repo read at all', async () => {
  const w = world({ issues: [hubbed(4)] })
  const empty = await withHub(undefined, () => w.coord.hub('on'))
  assert.equal(empty.ok, false)
  assert.equal(
    w.reads.length,
    0,
    'target resolution runs after the cheap guards',
  )
  assert.equal(w.posted.length, 0)
})

test('label matching is case-insensitive and tolerates a bare string label', async () => {
  for (const labels of [[{ name: 'HUB' }], ['hub'], [{ name: 'Hub' }]]) {
    const w = world({ issues: [{ number: 21, labels }] })
    const res = await withHub(undefined, () => w.coord.hub('shape tolerance'))
    assert.equal(res.ok, true, `labels ${JSON.stringify(labels)} must resolve`)
    assert.equal(res.hubNumber, 21)
  }
})
