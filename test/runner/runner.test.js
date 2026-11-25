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
      listIssues: async (options = {}) => {
        if ((options.state || 'open') !== 'closed') return issues
        // pi#151: a zero CLOSED window is UNKNOWN unless the population probe sees a population.
        // This world wants the CLEAN branch, so feed the two-bound probe slice one recent close.
        if (options.search && options.search.includes(' closed:<=')) {
          return [
            {
              number: 9,
              closedAt: new Date(Date.now() - 86400000).toISOString(),
            },
          ]
        }
        return []
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
        .includes('unattested-closure scan: quiet window, not a blind read'),
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
        if ((options.state || 'open') === 'closed') {
          if (options.search && options.search.includes(' closed:<=')) {
            return [
              {
                number: 9,
                closedAt: new Date(Date.now() - 86400000).toISOString(),
              },
            ]
          }
          return []
        }
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
        .includes('unattested-closure scan: quiet window, not a blind read'),
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
      listIssues: async (options = {}) => {
        if ((options.state || 'open') !== 'closed') return issues
        // pi#151: a zero CLOSED window is UNKNOWN unless the population probe sees a population.
        // This world wants the CLEAN branch, so feed the two-bound probe slice one recent close.
        if (options.search && options.search.includes(' closed:<=')) {
          return [
            {
              number: 9,
              closedAt: new Date(Date.now() - 86400000).toISOString(),
            },
          ]
        }
        return []
      },
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

describe('Runner: zero-tool no-progress loop breaker', () => {
  it('breaks out of --continue after 2 zero-tool cycles and backs off if fresh session also stalls', async () => {
    const capturedSessions = []
    const waits = []
    const issues = [
      {
        number: 1288,
        labels: [{ name: 'status:unclaimed' }, { name: 'type:bug' }],
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
      agent: 'echo',
      project: 'pp',
      targetPath: '/tmp/test',
      waitImpl: async (seconds, msg) => {
        waits.push({ seconds, msg })
        return false
      },
      sessionImpl: async (opts) => {
        capturedSessions.push(opts)
        // Cycles 1-3 simulate collapsed "Idle" exits; Cycle 4 recovers with real tool use
        const hadToolUse = capturedSessions.length === 4
        return { code: 0, hadToolUse }
      },
    })

    await runner.runLoop({ maxCycles: 5 })
    assert.equal(capturedSessions.length, 5)

    // Cycles 1 & 2 keep --continue
    assert.equal(capturedSessions[0].continueSession, true)
    assert.equal(capturedSessions[1].continueSession, true)
    assert.equal(waits[0].seconds, 10)
    assert.equal(waits[1].seconds, 10)

    // Cycle 3 breaks --continue (fresh session) after 2 consecutive zero-tool exits
    assert.equal(capturedSessions[2].continueSession, false)
    // Cycle 3 still returned hadToolUse: false, so backoff kicks in (60s) and Cycle 4 stays fresh
    assert.equal(waits[2].seconds, 60)
    assert.equal(capturedSessions[3].continueSession, false)

    // Cycle 4 recovered (hadToolUse: true), so wait returns to 10s and Cycle 5 resumes --continue
    assert.equal(waits[3].seconds, 10)
    assert.equal(capturedSessions[4].continueSession, true)
  })
})

describe('Runner: preflight error & rate-limit backoff', () => {
  it('queries rateLimit on GraphQL rate-limit error, waits until reset + buffer, and recovers', async () => {
    const nowMs = Date.parse('2026-11-22T11:00:00Z')
    const resetEpochSec = Math.floor(Date.parse('2026-11-22T11:25:00Z') / 1000)
    const waits = []
    const statuses = []
    let listCalls = 0
    let sessionCount = 0

    const runner = Runner({
      github: {
        listIssues: async (options = {}) => {
          listCalls += 1
          if (listCalls === 1) {
            throw new Error(
              'coord: gh issue list failed against Sullux/pitcairn-portal - GraphQL: API rate limit already exceeded for user ID 438228.',
            )
          }
          if ((options.state || 'open') === 'closed') return []
          return [
            {
              number: 55,
              labels: [{ name: 'status:unclaimed' }, { name: 'type:task' }],
              comments: [],
            },
          ]
        },
        listPrs: async () => [],
        rateLimit: async () => ({
          resources: {
            core: { limit: 5000, remaining: 4999, reset: resetEpochSec + 600 },
            graphql: { limit: 5000, remaining: 0, reset: resetEpochSec },
          },
        }),
      },
      agent: 'delta',
      project: 'pp',
      targetPath: '/tmp/test',
      now: () => nowMs,
      sessionTracker: {
        startSession: () => {},
        updateStatus: (_agent, st) => statuses.push(st),
        endSession: () => {},
      },
      waitImpl: async (seconds, msg) => {
        waits.push({ seconds, msg })
        return false
      },
      sessionImpl: async () => {
        sessionCount += 1
        return { code: 0, hadToolUse: true }
      },
    })

    const res = await runner.runLoop({ maxCycles: 1 })
    assert.equal(res.stopped, true)
    assert.equal(sessionCount, 1)
    // 25 minutes (1500s) + 5s buffer = 1505s
    assert.equal(waits[0].seconds, 1505)
    assert.match(waits[0].msg, /Rate Limit/)
    assert.match(waits[0].msg, /11:25:00Z/)
    assert.equal(statuses[0], 'waiting (rate-limit)')
  })

  it('falls back to 300s backoff on rate-limit when rateLimit throws or is unavailable, and on transient errors', async () => {
    const waits = []
    const statuses = []
    let calls = 0

    const runner = Runner({
      github: {
        listIssues: async () => {
          calls += 1
          if (calls === 1) {
            throw new Error('GraphQL: API rate limit already exceeded')
          }
          if (calls === 2) {
            throw new Error('HTTP 502 Bad Gateway')
          }
          return []
        },
        listPrs: async () => [],
        rateLimit: async () => {
          throw new Error('network error')
        },
      },
      agent: 'echo',
      project: 'pp',
      targetPath: '/tmp/test',
      sessionTracker: {
        startSession: () => {},
        updateStatus: (_agent, st) => statuses.push(st),
        endSession: () => {},
      },
      waitImpl: async (seconds, msg) => {
        waits.push({ seconds, msg })
        // Cancel on the 3rd wait (idle_empty after recovery)
        return waits.length >= 3
      },
    })

    const res = await runner.runLoop()
    assert.equal(res.reason, 'user_exit')
    assert.equal(waits[0].seconds, 300)
    assert.match(waits[0].msg, /Rate Limit/)
    assert.equal(statuses[0], 'waiting (rate-limit)')

    assert.equal(waits[1].seconds, 300)
    assert.match(waits[1].msg, /Preflight Error.*HTTP 502/)
    assert.equal(statuses[1], 'waiting (error)')
  })

  it('backs off idle_busy waits from 60s up to 300s and resets after a ready cycle', async () => {
    const waits = []
    let cycleIndex = 0
    const peerClaimed = [
      {
        number: 10,
        labels: [{ name: 'status:claimed' }],
        comments: [{ body: '**CLAIM** | agent: bravo' }],
      },
    ]
    const unclaimed = [
      {
        number: 11,
        labels: [{ name: 'status:unclaimed' }, { name: 'type:task' }],
        comments: [],
      },
    ]

    const runner = Runner({
      github: {
        listIssues: async (options = {}) => {
          if ((options.state || 'open') === 'closed') return []
          // First 5 open polls are idle_busy; 6th has work; 7th is idle_busy again
          return cycleIndex === 5 ? unclaimed : peerClaimed
        },
        listPrs: async () => [],
      },
      agent: 'alpha',
      project: 'pp',
      targetPath: '/tmp/test',
      waitImpl: async (seconds) => {
        cycleIndex += 1
        waits.push(seconds)
        return waits.length >= 7
      },
      sessionImpl: async () => ({ code: 0, hadToolUse: true }),
    })

    const res = await runner.runLoop()
    assert.equal(res.reason, 'user_exit')
    // 5 consecutive idle_busy waits: 60, 120, 240, 300, 300
    // then 10s session cooldown, then reset back to 60 on next idle_busy
    assert.deepEqual(waits, [60, 120, 240, 300, 300, 10, 60])
  })
})

describe('Runner: tool-using idle-spin loop breaker', () => {
  it('backs off and resets --continue when read-only turns exit idle or repeat verbatim', async () => {
    const sessions = []
    const waits = []
    const statuses = []
    const issues = [
      {
        number: 1393,
        labels: [{ name: 'status:unclaimed' }, { name: 'type:task' }],
        comments: [],
      },
    ]

    const runner = Runner({
      github: {
        listIssues: async (options = {}) =>
          (options.state || 'open') === 'closed' ? [] : issues,
        listPrs: async () => [],
      },
      agent: 'delta',
      project: 'pp',
      targetPath: '/tmp/test',
      sessionTracker: {
        startSession: () => {},
        updateStatus: (_a, s) => statuses.push(s),
        endSession: () => {},
      },
      waitImpl: async (seconds) => {
        waits.push(seconds)
        return false
      },
      sessionImpl: async (opts) => {
        sessions.push(opts)
        if (sessions.length <= 3) {
          return {
            code: 0,
            hadToolUse: true,
            hadEdit: false,
            isIdleExit: true,
            assistantText: 'Unchanged — no claimable tasks. Exiting cleanly.',
          }
        }
        if (sessions.length === 4) {
          return {
            code: 0,
            hadToolUse: true,
            hadEdit: true,
            isIdleExit: false,
            assistantText: 'Implemented #1393',
          }
        }
        // Cycles 5 & 6: verbatim non-edit repeat without isIdleExit flag
        return {
          code: 0,
          hadToolUse: true,
          hadEdit: false,
          isIdleExit: false,
          assistantText: 'Still checking #1393 dependencies.',
        }
      },
    })

    await runner.runLoop({ maxCycles: 6 })
    // Cycles 1-3: idle-spin backoff 60 -> 120 (breaks --continue) -> 240
    assert.equal(sessions[0].continueSession, true)
    assert.equal(sessions[1].continueSession, true)
    assert.equal(sessions[2].continueSession, false)
    assert.equal(sessions[3].continueSession, false)
    assert.deepEqual(waits.slice(0, 3), [60, 120, 240])
    assert.equal(statuses.includes('waiting (idle)'), true)

    // Cycle 4 edited files -> resets to 10s and resumes --continue on Cycle 5
    assert.equal(waits[3], 10)
    assert.equal(sessions[4].continueSession, true)

    // Cycle 5 first non-idle text -> 10s; Cycle 6 verbatim repeat -> 60s backoff
    assert.equal(waits[4], 10)
    assert.equal(waits[5], 60)
  })
})

describe('Runner: merge-ready PR wake prompt', () => {
  it('surfaces mergeReadyPrs in the cycle prompt when an authored PR is approved at current head', async () => {
    const prompts = []
    const issues = [
      {
        number: 1538,
        labels: [{ name: 'status:in-review' }],
        comments: [{ body: '**CLAIM** | agent: charlie' }],
      },
    ]
    const prs = [
      {
        number: 1539,
        headRefName: 'docs/1538-verdict-refetch',
        headRefOid: 'dac21c2a0011223344556677889900aabbccddee',
        closingIssuesReferences: [{ number: 1538 }],
        comments: [
          {
            body: '**REVIEW** | agent: agent-alpha | head `dac21c2`\n\nAPPROVE',
          },
        ],
      },
    ]

    const runner = Runner({
      github: {
        listIssues: async (options = {}) =>
          (options.state || 'open') === 'closed' ? [] : issues,
        listPrs: async () => prs,
      },
      agent: 'charlie',
      project: 'pp',
      targetPath: '/tmp/test',
      waitImpl: async () => false,
      sessionImpl: async (opts) => {
        prompts.push(opts.prompt)
        return { code: 0, hadToolUse: true, hadEdit: true }
      },
    })

    await runner.runLoop({ maxCycles: 1 })
    assert.equal(prompts.length, 1)
    assert.match(prompts[0], /Merge hand ready on 1 authored PR \(#1539\)/)
  })
})
