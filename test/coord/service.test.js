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
})
