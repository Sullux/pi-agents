const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Runner } = require('../../src/runner')

describe('Runner: Loop Execution and Directional Prompts', () => {
  it('passes directional prompt when unclaimed tasks are available', async () => {
    let capturedSession = null
    const issues = [
      {
        number: 55,
        labels: [{ name: 'status:unclaimed' }, { name: 'type:task' }],
        comments: [],
      },
    ]

    const mockGithub = {
      listIssues: async () => issues,
      listPrs: async () => [],
    }

    const runner = Runner({
      github: mockGithub,
      agent: 'bravo',
      project: 'pp',
      targetPath: '/tmp/test',
      waitImpl: async () => false,
      sessionImpl: async (opts) => {
        capturedSession = opts
        return { code: 0 }
      },
    })

    const res = await runner.runLoop({ maxCycles: 1 })
    assert.equal(res.stopped, true)
    assert.equal(res.reason, 'max_cycles_reached')
    assert.ok(
      capturedSession.prompt.includes(
        'Actionable unclaimed tasks are available',
      ),
    )
    assert.ok(capturedSession.prompt.includes('page coord board'))
  })

  it('passes directional prompt when peer PRs are awaiting review', async () => {
    let capturedSession = null
    const issues = [
      {
        number: 55,
        labels: [{ name: 'status:claimed' }],
        comments: [{ body: '**CLAIM** | agent: charlie' }],
      },
    ]

    const mockGithub = {
      listIssues: async () => issues,
      listPrs: async () => [{ number: 99 }],
    }

    const runner = Runner({
      github: mockGithub,
      agent: 'bravo',
      project: 'pp',
      targetPath: '/tmp/test',
      waitImpl: async () => false,
      sessionImpl: async (opts) => {
        capturedSession = opts
        return { code: 0 }
      },
    })

    const res = await runner.runLoop({ maxCycles: 1 })
    assert.equal(res.stopped, true)
    assert.ok(
      capturedSession.prompt.includes(
        'Open pull requests are awaiting peer review',
      ),
    )
  })
})
