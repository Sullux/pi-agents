const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const {
  RunnerCurrency,
  adviceProvenanceLine,
} = require('../../src/cli/runner-currency')
const { resolveCyclePrompt } = require('../../src/runner')
const { Runner } = require('../../src/runner')

// #133: advice a stale runner emits must name the code that emitted it, in the same breath. These arms
// pin the self-reading half, the pure sentence, and the REAL composition path - never a re-implement of
// the formatter at the call site.

const BOOT = 1_700_000_000_000
const fakeProc = (entries) => () => entries
const selfEntry = (pid) => ({
  pid,
  bootEpochMs: BOOT - 1000,
  starttimeTicks: 1000,
  cwd: '/tmp/x',
  argv: ['node', 'page', 'start', 'charlie', 'pp'],
})

const reflog = (rows) =>
  rows.map(([sha, epochSec]) => `${sha} ${epochSec}`).join('\n')

describe('#133 selfRead: the process reads its own provenance', () => {
  it('names the loaded sha and the merge count when the boot is stale', () => {
    let gitCalls = 0
    const git = (args) => {
      gitCalls += 1
      if (args[0] === 'reflog')
        return reflog([
          ['aaaa111', BOOT / 1000 - 5],
          ['bbbb222', BOOT / 1000 - 1],
        ])
      if (args[0] === 'rev-list') return '8\n'
      return ''
    }
    const currency = RunnerCurrency({
      git,
      proc: fakeProc([selfEntry(42)]),
      selfPid: 42,
    })
    const read = currency.selfRead()
    assert.equal(read.state, 'stale')
    assert.equal(read.sha, 'bbbb222')
    assert.equal(read.behind, 8)
    assert.ok(
      gitCalls > 0,
      'the seam must be TRAVELED, not re-derived at the call site',
    )
  })

  it('reports current when nothing landed since the boot', () => {
    const git = (args) =>
      args[0] === 'reflog' ? reflog([['cccc333', BOOT / 1000 - 1]]) : '0\n'
    const read = RunnerCurrency({
      git,
      proc: fakeProc([selfEntry(7)]),
      selfPid: 7,
    }).selfRead()
    assert.equal(read.state, 'current')
  })

  it('returns the older-than-reflog state rather than a fabricated sha', () => {
    const git = (args) =>
      args[0] === 'reflog' ? reflog([['dddd444', BOOT / 1000 + 60]]) : '3\n'
    const read = RunnerCurrency({
      git,
      proc: fakeProc([selfEntry(9)]),
      selfPid: 9,
    }).selfRead()
    assert.equal(read.state, 'unknown')
  })

  it('degrades to undefined when a read throws - suppression, never a guess', () => {
    const currency = RunnerCurrency({
      git: () => {
        throw new Error('git died')
      },
      proc: fakeProc([selfEntry(1)]),
      selfPid: 1,
    })
    assert.equal(currency.selfRead(), undefined)
  })

  it('is undefined when /proc has no entry for this pid (fake world without self)', () => {
    const currency = RunnerCurrency({
      git: () => '',
      proc: fakeProc([]),
      selfPid: 555,
    })
    assert.equal(currency.selfRead(), undefined)
  })
})

describe('#133 adviceProvenanceLine: one pure sentence shape', () => {
  it('prints nothing for current or unreadable', () => {
    assert.equal(adviceProvenanceLine({ state: 'current' }), '')
    assert.equal(adviceProvenanceLine(undefined), '')
  })

  it('names sha, count and the restart remedy for a stale read', () => {
    const line = adviceProvenanceLine({
      state: 'stale',
      sha: 'e549da9',
      behind: 2,
    })
    assert.match(line, /loaded e549da9 \(2 merges behind origin\/main\)/)
    assert.match(line, /may predate the fix that changed it/)
    assert.match(line, /page start <agent> <project>/)
  })

  it('uses the older-than-reflog phrase for unknown, and says unknown for an unreadable count', () => {
    assert.match(
      adviceProvenanceLine({ state: 'unknown' }),
      /older than the retained reflog/,
    )
    const odd = adviceProvenanceLine({
      state: 'stale',
      sha: 'abcdef1',
      behind: NaN,
    })
    assert.match(odd, /merge count unknown \(git could not answer\)/)
    assert.match(
      adviceProvenanceLine({ state: 'stale', sha: 'abcdef1', behind: 1 }),
      /1 merge behind/,
    )
  })
})

const advicePrompt = (runnerCurrency, extra = {}) =>
  resolveCyclePrompt({
    reviewGaps: [{ number: 12, gap: 'rebase owed', hint: 'needs rebase' }],
    runnerCurrency,
    ...extra,
  })

describe('#133 composition: the rendered string rides the real path', () => {
  it('advice and provenance appear together when the seam reads stale', () => {
    const prompt = advicePrompt({
      selfRead: () => ({ state: 'stale', sha: 'feedfa1', behind: 3 }),
    })
    assert.ok(prompt.includes('Review owed on 1 open PR'), prompt)
    assert.ok(
      prompt.includes(
        "Advice provenance: this runner process's code is loaded feedfa1 (3 merges behind origin/main)",
      ),
      prompt,
    )
  })

  it('stays byte-identical for a current boot - no extra noise', () => {
    const bare = resolveCyclePrompt({
      reviewGaps: [{ number: 12, gap: 'rebase owed', hint: 'needs rebase' }],
    })
    assert.equal(advicePrompt({ selfRead: () => ({ state: 'current' }) }), bare)
  })

  it('does not consult the seam at all when there is no advice (absent)', () => {
    let calls = 0
    resolveCyclePrompt({
      runnerCurrency: {
        selfRead: () => (calls++, { state: 'stale', sha: 'x', behind: 1 }),
      },
    })
    assert.equal(calls, 0)
  })

  it('a seam whose reads throw yields no line and no crash, and WAS called (suppressed)', () => {
    let calls = 0
    const bomb = {
      selfRead: () => {
        calls += 1
        throw new Error('fake read died')
      },
    }
    const prompt = advicePrompt(bomb)
    assert.equal(
      calls,
      1,
      'suppressed must be distinguishable from absent: the seam ran',
    )
    assert.ok(prompt.includes('Review owed on 1 open PR'))
    assert.ok(!prompt.includes('Advice provenance'), prompt)
  })

  it('the closure report alone counts as advice too', () => {
    const prompt = resolveCyclePrompt({
      closures: {
        note: 'unattested-closure scan: the read FAILED (UNKNOWN, not clean)',
      },
      runnerCurrency: { selfRead: () => ({ state: 'unknown' }) },
    })
    assert.ok(prompt.includes('the read FAILED'), prompt)
    assert.ok(prompt.includes('older than the retained reflog'), prompt)
  })
})

describe('#133 the loop threads the seam through the real Runner', () => {
  it('runLoop passes runnerCurrency into the cycle prompt', async () => {
    let captured = null
    const issues = [
      { number: 55, labels: [{ name: 'status:unclaimed' }], comments: [] },
    ]
    const mockGithub = {
      listIssues: async (options = {}) =>
        (options.state || 'open') === 'closed' ? [] : issues,
      listPrs: async () => [],
    }
    let seamCalls = 0
    const runner = Runner({
      github: mockGithub,
      agent: 'charlie',
      project: 'pp',
      targetPath: '/tmp/test',
      waitImpl: async () => false,
      sessionImpl: async (opts) => {
        captured = opts
        return { code: 0 }
      },
      runnerCurrency: {
        selfRead: () => {
          seamCalls += 1
          return { state: 'stale', sha: 'cafe123', behind: 6 }
        },
      },
    })
    await runner.runLoop({ maxCycles: 1 })
    assert.ok(
      seamCalls >= 1,
      'the per-cycle path must travel the injected seam',
    )
    assert.ok(
      captured.prompt.includes('loaded cafe123 (6 merges behind origin/main)'),
      captured.prompt,
    )
  })
})
