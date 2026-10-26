const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { CoordService } = require('../../src/coord')

describe('Coordination Protocol: Service Methods', () => {
  it('hub command strips leading subverbs and formats SYNC comment', async () => {
    let posted = []
    const mockGithub = {
      commentIssue: async (num, body) => {
        posted.push({ num, body })
      },
    }

    const coord = CoordService({
      github: mockGithub,
      agent: 'delta',
      human: 'Sullux',
    })

    await coord.hub('on starting journey tests; nothing blocking')
    assert.equal(posted.length, 1)
    assert.equal(posted[0].num, 4)
    assert.ok(posted[0].body.includes('delta | human: @Sullux'))
    assert.ok(
      posted[0].body.includes('starting journey tests; nothing blocking'),
    )
    assert.ok(!posted[0].body.includes('on starting'))
  })

  it('review command moves issue to status:in-review and posts comment', async () => {
    let edited = []
    let commented = []

    const mockGithub = {
      viewIssue: async (num) => ({
        number: num,
        labels: [{ name: 'status:claimed' }, { name: 'p1' }],
      }),
      commentIssue: async (num, body) => {
        commented.push({ num, body })
      },
      editIssue: async (num, edits) => {
        edited.push({ num, edits })
      },
    }

    const coord = CoordService({
      github: mockGithub,
      agent: 'alpha',
      human: 'Sullux',
      now: () => 1700000000000,
    })

    const res = await coord.review(50, { pr: 123, text: 'ready for review' })
    assert.equal(res.ok, true)
    assert.deepEqual(edited[0].edits.addLabels, ['status:in-review'])
    assert.deepEqual(edited[0].edits.removeLabels, ['status:claimed'])
    assert.ok(commented[0].body.includes('**REVIEW** | agent: agent-alpha'))
    assert.ok(commented[0].body.includes('pr: #123'))
  })

  it('done command strips status labels, closes issue, and avoids status:done', async () => {
    let closed = []
    let edited = []
    let commented = []

    const mockGithub = {
      viewIssue: async (num) => ({
        number: num,
        labels: [{ name: 'status:in-review' }, { name: 'p1' }],
      }),
      commentIssue: async (num, body) => {
        commented.push({ num, body })
      },
      editIssue: async (num, edits) => {
        edited.push({ num, edits })
      },
      closeIssue: async (num) => {
        closed.push(num)
      },
    }

    const coord = CoordService({
      github: mockGithub,
      agent: 'alpha',
      human: 'Sullux',
      now: () => 1700000000000,
    })

    const res = await coord.done(50, { pr: 123, text: 'resolved cleanly' })
    assert.equal(res.ok, true)
    assert.equal(closed[0], 50)
    assert.deepEqual(edited[0].edits.removeLabels, ['status:in-review'])
    assert.equal(edited[0].edits.addLabels, undefined)
    assert.ok(commented[0].body.includes('**DONE** | agent: agent-alpha'))
    assert.ok(commented[0].body.includes('pr: #123'))
  })

  it('formatBoard does not truncate long agent owner IDs', () => {
    const { formatBoard } = require('../../src/coord/formatters')
    const longAgent = 'qwen3.8-flash-foxtrot'
    const issues = [
      {
        number: 758,
        title: 'Long owner ID test',
        body: '## Files\nsrc/test.js',
        labels: [{ name: 'status:claimed' }, { name: 'ws:admin' }],
        comments: [{ body: `**CLAIM** | agent: ${longAgent} | at: 100` }],
      },
    ]

    const board = formatBoard(issues, 'other')
    assert.ok(board.includes(longAgent))
  })
})
