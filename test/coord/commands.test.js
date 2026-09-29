const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const {
  Commands,
} = require('../../.agents/skills/coordinate/scripts/lib/commands')

describe('Coordinate Skill: Commands', () => {
  it('hub command strips leading subverbs and formats SYNC comment', async () => {
    let posted = []
    const mockGithub = {
      commentIssue: async (num, body) => {
        posted.push({ num, body })
      },
    }

    const cmd = Commands({
      github: mockGithub,
      agent: 'delta',
      human: 'Sullux',
    })

    await cmd.hub('on starting journey tests; nothing blocking')
    assert.equal(posted.length, 1)
    assert.equal(posted[0].num, 4)
    assert.ok(posted[0].body.includes('delta | human: @Sullux'))
    assert.ok(
      posted[0].body.includes('starting journey tests; nothing blocking'),
    )
    assert.ok(!posted[0].body.includes('on starting'))
  })

  it('done command marks issue done and closes issue', async () => {
    let closed = []
    let edited = []
    let commented = []

    const mockGithub = {
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

    const cmd = Commands({
      github: mockGithub,
      agent: 'alpha',
      human: 'Sullux',
      now: () => 1700000000000,
    })

    const res = await cmd.done(50, { pr: 123, text: 'resolved cleanly' })
    assert.equal(res, 'Closed #50 as done')
    assert.equal(closed[0], 50)
    assert.deepEqual(edited[0].edits.addLabels, ['status:done'])
    assert.ok(commented[0].body.includes('**DONE** | agent: agent-alpha'))
    assert.ok(commented[0].body.includes('pr: #123'))
  })
})
