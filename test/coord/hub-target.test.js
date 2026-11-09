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
  taxonomy = ['bug', 'hub'],
  taxonomyThrows = null,
  hasLabelsSeam = true,
} = {}) => {
  const posted = []
  const reads = []
  const labelReads = []
  const github = {
    repo,
    issueKind: async () => kind,
    commentIssue: async (num, body) => posted.push({ num, body }),
  }
  // #53 review ask: the refusal has to know the repo's taxonomy to advise an exit that works, so
  // the fake models all four shapes a real client can present: label present, label absent (pi-agents
  // today), the read throwing, and an older client with no seam at all.
  if (hasLabelsSeam) {
    github.listLabels = async () => {
      labelReads.push(repo)
      if (taxonomyThrows) throw taxonomyThrows
      return taxonomy
    }
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
    labelReads,
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

// ── #53 review ask: the refusal must not advise a step GitHub refuses in this repo ──
// Measured live at ab40bd2: pi-agents' taxonomy is 10 labels with no `hub`, so
// `gh issue edit --add-label hub` dies with `could not add label` and creates NO artifact. The old
// sentence offered `label one issue 'hub'` unconditionally.

test('a taxonomy that HAS the hub label keeps advising it - the pitcairn shape', async () => {
  const w = world({ issues: [], taxonomy: ['bug', 'hub', 'ws:infra'] })
  const res = await w.coord.hub('a fleet line')
  assert.equal(res.ok, false, 'no hub ISSUE is open, so it still refuses')
  assert.equal(w.posted.length, 0, 'a refusal must not have posted')
  assert.match(res.error, /label one issue 'hub' or set COORD_HUB/, res.error)
  assert.ok(
    !/taxonomy has no/.test(res.error),
    'do not claim the label is missing when it exists',
  )
})

test('a taxonomy WITHOUT the hub label points at COORD_HUB first - the pi-agents shape', async () => {
  const w = world({ issues: [], taxonomy: ['bug', 'enhancement', 'p1'] })
  const res = await w.coord.hub('a fleet line')
  assert.match(
    res.error,
    /set COORD_HUB=<open issue> - this repo's taxonomy has no 'hub' label/,
    res.error,
  )
  assert.match(
    res.error,
    /minting one is a fleet decision: gh label create hub in Sullux\/pi-agents - nothing was posted$/,
    res.error,
  )
  assert.ok(
    !res.error.includes("unset - label one issue 'hub' or set COORD_HUB"),
    'the refused instruction must not survive as the advice',
  )
  assert.equal(w.posted.length, 0, 'refused means nothing was posted')
})

test('a taxonomy read that THROWS says unknown, never absent', async () => {
  const w = world({
    issues: [],
    taxonomyThrows: new Error('gh label list failed against Sullux/pi-agents'),
  })
  const res = await w.coord.hub('a fleet line')
  assert.match(res.error, /the label taxonomy could not be read/, res.error)
  assert.match(res.error, /cannot claim 'hub' is absent/, res.error)
  assert.ok(
    !/taxonomy has no 'hub' label/.test(res.error),
    'an unreadable taxonomy must never be reported as a missing label',
  )
  assert.equal(w.posted.length, 0)
})

test('an older client with no label seam hedges instead of asserting', async () => {
  const w = world({ issues: [], hasLabelsSeam: false })
  const res = await w.coord.hub('a fleet line')
  assert.match(
    res.error,
    /label one issue 'hub' if that label exists here/,
    res.error,
  )
  assert.equal(w.labelReads.length, 0, 'no seam means no read attempted')
})

test('the taxonomy is case-insensitive: a HUB label in the list counts as present', async () => {
  const w = world({ issues: [], taxonomy: ['HUB', 'bug'] })
  const res = await w.coord.hub('a fleet line')
  assert.match(res.error, /label one issue 'hub' or set COORD_HUB/, res.error)
})

test('non-vacuity: the taxonomy is read ONCE on the refusal path and ZERO times on success', async () => {
  const miss = world({ issues: [], taxonomy: ['bug'] })
  await miss.coord.hub('a fleet line')
  assert.equal(
    miss.labelReads.length,
    1,
    `refusal should read the taxonomy once: ${miss.labelReads}`,
  )
  const hit = world({ issues: [hubbed(7)], taxonomy: ['bug', 'hub'] })
  const res = await hit.coord.hub('a fleet line')
  assert.equal(res.hubNumber, 7)
  assert.equal(
    hit.labelReads.length,
    0,
    'a resolved hub must not pay for a taxonomy read',
  )
})

test('the whole sentence, as a reader receives it in a repo with no hub label', async () => {
  const w = world({
    issues: [],
    repo: 'Sullux/pi-agents',
    taxonomy: ['bug', 'docs', 'p1'],
  })
  const res = await w.coord.hub('a fleet line')
  assert.equal(
    res.error,
    "hub: no open issue carries the 'hub' label and COORD_HUB is unset - set COORD_HUB=<open issue> - this repo's taxonomy has no 'hub' label to apply, and minting one is a fleet decision: gh label create hub in Sullux/pi-agents - nothing was posted",
  )
})
