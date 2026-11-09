const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const {
  Runner,
  resolveCyclePrompt,
  describeReviewGaps,
} = require('../../src/runner')

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

// #90: preflight now names WHY a PR is still owed review (unsigned verdict / moved head / a head-cited
// attestation that is not a verdict). The sentence is computed in preflight and only JOINED here, so the
// arms below drive the real Runner and assert the rendered string - not a re-derivation of the causes.
describe('Runner: #90 review-gap advice reaches the cycle prompt', () => {
  const CHARLIE_WITNESS =
    '**NON-SELF WITNESS for box 5** | agent: agent-charlie | measured at `a029d24810314ee042b0235f2ab0c495bfd27d3f`'
  const claimedIssues = [
    {
      number: 20,
      labels: [{ name: 'status:claimed' }],
      comments: [{ body: '**CLAIM** | agent: bravo' }],
    },
  ]

  it('the prompt an agent actually receives carries the cause and the PR number', async () => {
    let capturedSession = null
    const runner = Runner({
      github: {
        listIssues: async () => claimedIssues,
        listPrs: async () => [
          {
            number: 84,
            headRefOid: 'a029d24810314ee042b0235f2ab0c495bfd27d3f',
            comments: [{ body: CHARLIE_WITNESS }],
          },
        ],
      },
      agent: 'echo',
      project: 'pp',
      targetPath: '/tmp/test',
      waitImpl: async () => false,
      sessionImpl: async (opts) => {
        capturedSession = opts
        return { code: 0 }
      },
    })

    await runner.runLoop({ maxCycles: 1 })
    assert.match(capturedSession.prompt, /Review owed on 1 open PR - #84: /)
    assert.match(capturedSession.prompt, /NON-SELF WITNESS for box 5/)
    assert.match(capturedSession.prompt, /verdict is still owed/)
  })

  it('no gaps means the prompt is byte-identical to the pre-#90 string', () => {
    assert.equal(describeReviewGaps([]), '')
    assert.equal(
      resolveCyclePrompt({ isNewTask: false, reviewGaps: [] }),
      'Continue development using the coordinate skill.',
    )
    assert.equal(
      resolveCyclePrompt({
        isNewTask: true,
        steering: 'Focus only on payments',
      }),
      'Proceed with development using the coordinate skill (finish any in-progress work, or check the board and PRs if ready for a new task). Explicit steering from user: Focus only on payments',
    )
  })

  it('a cap that truncates says how many it dropped, and skips already-reviewed PRs', () => {
    const gaps = [1, 2, 3, 4, 5, 6].map((n) => ({
      number: n,
      gap: 'unreviewed',
      hint: 'no verdict on this thread yet',
    }))
    gaps.push({ number: 77, gap: 'reviewed', hint: '' })

    const line = describeReviewGaps(gaps)
    assert.match(line, /Review owed on 6 open PRs/)
    assert.match(line, /\(\+2 more\)/)
    assert.doesNotMatch(line, /#77/)
    assert.equal(line.split('#').length - 1, 4, 'exactly four PRs are shown')
  })
})
