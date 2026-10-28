const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Runner } = require('../../src/runner')

describe('Runner: Loop Execution and Continuation Prompts', () => {
  it('passes minimal continuation prompt when continuing an active session', async () => {
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
    assert.equal(
      capturedSession.prompt,
      'Continue development using the coordinate skill.',
    )
    assert.equal(capturedSession.continueSession, true)
  })

  it('passes balanced transition prompt when starting a new task after completing a claim', async () => {
    let cycleCount = 0
    const capturedSessions = []

    const issuesCycle1 = [
      {
        number: 10,
        labels: [{ name: 'status:claimed' }],
        comments: [{ body: '**CLAIM** | agent: bravo' }],
      },
    ]

    const issuesCycle2 = [
      {
        number: 20,
        labels: [{ name: 'status:unclaimed' }, { name: 'type:task' }],
        comments: [],
      },
    ]

    const mockGithub = {
      listIssues: async () => (cycleCount === 0 ? issuesCycle1 : issuesCycle2),
      listPrs: async () => [],
    }

    const runner = Runner({
      github: mockGithub,
      agent: 'bravo',
      project: 'pp',
      targetPath: '/tmp/test',
      waitImpl: async () => false,
      sessionImpl: async (opts) => {
        cycleCount += 1
        capturedSessions.push(opts)
        return { code: 0 }
      },
    })

    const res = await runner.runLoop({ maxCycles: 2 })
    assert.equal(res.stopped, true)
    assert.equal(capturedSessions.length, 2)

    // Cycle 1: Continuing claim
    assert.equal(
      capturedSessions[0].prompt,
      'Continue development using the coordinate skill.',
    )
    assert.equal(capturedSessions[0].continueSession, true)

    // Cycle 2: Transition from owned_claims to unclaimed_tasks
    assert.ok(
      capturedSessions[1].prompt.includes(
        'finish any in-progress work, or check the board',
      ),
    )
    assert.equal(capturedSessions[1].continueSession, false)
  })

  it('appends explicit steering when provided', async () => {
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
      steering: 'Focus only on payments',
      waitImpl: async () => false,
      sessionImpl: async (opts) => {
        capturedSession = opts
        return { code: 0 }
      },
    })

    const res = await runner.runLoop({ maxCycles: 1 })
    assert.equal(res.stopped, true)
    assert.ok(
      capturedSession.prompt.endsWith(
        'Explicit steering from user: Focus only on payments',
      ),
    )
  })
})
