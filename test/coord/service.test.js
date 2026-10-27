const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { CoordService } = require('../../src/coord')

describe('CoordService', () => {
  it('claim succeeds on clean issue with valid files scope', async () => {
    const mockIssue = {
      number: 42,
      body: '## Files\nsrc/foo.js\n\n## Goal\nTest',
      labels: [{ name: 'status:unclaimed' }],
      comments: [],
    }

    let commentsPosted = []
    let labelsEdited = []

    const mockGithub = {
      viewIssue: async () => mockIssue,
      listIssues: async () => [mockIssue],
      commentIssue: async (num, body) => {
        commentsPosted.push({ num, body })
      },
      editIssue: async (num, edits) => {
        labelsEdited.push({ num, edits })
      },
    }

    const coord = CoordService({
      github: mockGithub,
      agent: 'alpha',
      human: 'Sullux',
      now: () => 1700000000000,
    })

    const result = await coord.claim(42, { plan: 'my plan', eta: '10m' })
    assert.equal(result.ok, true)
    assert.equal(commentsPosted.length, 1)
    assert.ok(
      commentsPosted[0].body.includes(
        '**CLAIM** | agent: agent-alpha | human: @Sullux',
      ),
    )
    assert.ok(commentsPosted[0].body.includes('at: 1700000000000'))
    assert.equal(labelsEdited.length, 1)
    assert.deepEqual(labelsEdited[0].edits.addLabels, ['status:claimed'])
  })

  it('claim fails if issue declares no Files scope', async () => {
    const mockIssue = {
      number: 43,
      body: '## Goal\nNo files listed',
      labels: [{ name: 'status:unclaimed' }],
      comments: [],
    }

    const mockGithub = {
      viewIssue: async () => mockIssue,
      listIssues: async () => [mockIssue],
    }

    const coord = CoordService({ github: mockGithub, agent: 'alpha' })
    const result = await coord.claim(43)

    assert.equal(result.ok, false)
    assert.ok(result.error.includes('declares no Files scope'))
  })

  it('claim fails if files collide with an active peer claim', async () => {
    const collidingPeerIssue = {
      number: 10,
      body: '## Files\nsrc/shared.js',
      labels: [{ name: 'status:claimed' }],
      comments: [{ body: '**CLAIM** | agent: bravo' }],
    }
    const targetIssue = {
      number: 11,
      body: '## Files\nsrc/shared.js\nsrc/other.js',
      labels: [{ name: 'status:unclaimed' }],
      comments: [],
    }

    const mockGithub = {
      viewIssue: async () => targetIssue,
      listIssues: async () => [collidingPeerIssue, targetIssue],
    }

    const coord = CoordService({ github: mockGithub, agent: 'alpha' })
    const result = await coord.claim(11)

    assert.equal(result.ok, false)
    assert.ok(result.error.includes('collides with #10 held by bravo'))
  })
  // #863: the end-to-end half. The pure-function pins prove the classifier; these prove `claim`
  // actually LETS the claim through and that the warning reaches both surfaces an agent reads -
  // the returned object (stdout) and the CLAIM comment (the timeline teammates read).
  it('claim SUCCEEDS against an in-review overlap and records the owed rebase (#863)', async () => {
    const inReview = {
      number: 786,
      body: '## Files\npublic/styles/global.css\ntest/e2e/resident.spec.js',
      labels: [{ name: 'status:in-review' }],
      comments: [{ body: '**CLAIM** | agent: agent-echo' }],
    }
    const target = {
      number: 820,
      body: '## Files\npublic/styles/global.css\ntest/e2e/resident.spec.js',
      labels: [{ name: 'status:unclaimed' }],
      comments: [],
    }
    const posted = []
    const mockGithub = {
      viewIssue: async () => target,
      listIssues: async () => [inReview, target],
      commentIssue: async (num, body) => posted.push({ num, body }),
      editIssue: async () => {},
    }

    const coord = CoordService({ github: mockGithub, agent: 'bravo', now: () => 1700000000000 })
    const result = await coord.claim(820, { plan: 'css consolidation' })

    assert.equal(result.ok, true, `expected the claim to go through, got: ${result.error}`)
    assert.equal(result.warnings.length, 1)
    assert.equal(result.warnings[0].issue, 786)

    const claim = posted.find((c) => c.body.startsWith('**CLAIM**'))
    assert.ok(claim, 'the CLAIM comment was posted')
    assert.ok(claim.body.includes('#786'), `the warning names the issue: ${claim.body}`)
    assert.ok(
      claim.body.includes('public/styles/global.css'),
      `and the overlapping paths: ${claim.body}`,
    )
    assert.ok(claim.body.includes('rebase'), `and says a rebase is owed: ${claim.body}`)
  })

  it('a hard collision still refuses, and the refusal names the blocking status (#863)', async () => {
    const inProgress = {
      number: 770,
      body: '## Files\nsrc/sites/resident/src/pages/post.astro',
      labels: [{ name: 'status:in-progress' }],
      comments: [{ body: '**CLAIM** | agent: agent-delta' }],
    }
    const target = {
      number: 820,
      body: '## Files\nsrc/sites/resident/src/pages/post.astro',
      labels: [{ name: 'status:unclaimed' }],
      comments: [],
    }
    const posted = []
    const mockGithub = {
      viewIssue: async () => target,
      listIssues: async () => [inProgress, target],
      commentIssue: async (num, body) => posted.push({ num, body }),
      editIssue: async () => {},
    }

    const coord = CoordService({ github: mockGithub, agent: 'bravo' })
    const result = await coord.claim(820)

    assert.equal(result.ok, false)
    assert.ok(result.error.includes('status:in-progress'), result.error)
    assert.ok(result.error.includes('split: #820'), `the escape is discoverable: ${result.error}`)
    assert.equal(posted.length, 0, 'a refused claim posts nothing - verified at the effect')
  })

  it("a split: line in the target's own body waives a live overlap (#863)", async () => {
    const inProgress = {
      number: 770,
      body: '## Files\nsrc/sites/resident/src/pages/post.astro',
      labels: [{ name: 'status:in-progress' }],
      comments: [{ body: '**CLAIM** | agent: agent-delta' }],
    }
    const target = {
      number: 820,
      body: '## Files\nsrc/sites/resident/src/pages/post.astro\nsplit: #770',
      labels: [{ name: 'status:unclaimed' }],
      comments: [],
    }
    const mockGithub = {
      viewIssue: async () => target,
      listIssues: async () => [inProgress, target],
      commentIssue: async () => {},
      editIssue: async () => {},
    }

    const coord = CoordService({ github: mockGithub, agent: 'bravo' })
    const result = await coord.claim(820)
    assert.equal(result.ok, true, `expected the waiver to free the claim, got: ${result.error}`)
    assert.deepEqual(result.warnings, [])
  })
})
