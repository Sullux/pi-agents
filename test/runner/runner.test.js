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
      listIssues: async (options = {}) =>
        (options.state || 'open') === 'closed' ? [] : issues,
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
    // #99 widened this string: the cycle prompt now carries the unattested-closure line, so the
    // guarantee these arms own is "the base sentence is line one", not "the prompt is only the base".
    const [firstLine, ...rest] = capturedSession.prompt.split('\n')
    assert.equal(firstLine, 'Continue development using the coordinate skill.')
    assert.ok(
      rest
        .join('\n')
        .includes('unattested-closure scan: 0 closed issue(s) scanned'),
      `the scan's population line must be present, even when clean: ${capturedSession.prompt}`,
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
      listIssues: async (options = {}) => {
        // #99: the scan reads the closed axis with its own call - a mock that ignored `state` handed
        // it open rows and the report counted them as closures.
        if ((options.state || 'open') === 'closed') return []
        return cycleCount === 0 ? issuesCycle1 : issuesCycle2
      },
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
    // #99: same widening as the first arm - line one is still the base sentence, and the cycle prompt now
    // also carries the scan's population line (here: a clean, empty scan, which must still be named).
    const [contFirst, ...contRest] = capturedSessions[0].prompt.split('\n')
    assert.equal(contFirst, 'Continue development using the coordinate skill.')
    assert.ok(
      contRest
        .join('\n')
        .includes('unattested-closure scan: 0 closed issue(s) scanned'),
      `clean sweeps stay visible so absence is not mistaken for blindness: ${capturedSessions[0].prompt}`,
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
      listIssues: async (options = {}) =>
        (options.state || 'open') === 'closed' ? [] : issues,
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
// #99: the renderer side. A scan whose result nothing prints is a report that exists only in tests, so
// these arms read the PROMPT STRING the agent receives, not the source of the function that builds it.
describe('Runner: closure note reaches the prompt (#99)', () => {
  it('appends the scan note to the cycle prompt when there is one', () => {
    const prompt = resolveCyclePrompt({
      isNewTask: true,
      closures: {
        note: 'unattested-closure scan: 4 scanned, 2 closed within the last 6h, 1 unattested - #7 0/2 ticked, closed 2026-11-10T00:00:00Z',
      },
    })
    assert.ok(prompt.includes('unattested-closure scan'), prompt)
    assert.ok(
      prompt.includes('#7 0/2 ticked'),
      'the named population survives into the prompt',
    )
    assert.ok(
      prompt.startsWith('Proceed with development'),
      'the base sentence is still first',
    )
  })

  it('does not invent a line when the scan returned nothing to say', () => {
    const bare = resolveCyclePrompt({ isNewTask: false })
    const withNull = resolveCyclePrompt({ isNewTask: false, closures: null })
    assert.equal(withNull, bare, 'a null closures must not change the prompt')
    assert.ok(!withNull.includes('unattested-closure'), withNull)
  })

  it('carries the UNKNOWN form unchanged, so the agent is not told the repo is clean', () => {
    const prompt = resolveCyclePrompt({
      closures: {
        note: 'unattested-closure scan of the CLOSED axis: the read FAILED (…) - UNKNOWN, not clean',
      },
    })
    assert.ok(prompt.includes('UNKNOWN, not clean'), prompt)
  })
})
