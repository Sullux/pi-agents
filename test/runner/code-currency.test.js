const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { CodeCurrency } = require('../../src/runner/code-currency')
const { Runner, resolveCyclePrompt } = require('../../src/runner')

const LOADED = 'a'.repeat(40)
const TIP = 'b'.repeat(40)
const TIP_DATE = '2026-11-10T01:42:49-04:00'

// A script answers by (key, nth-call-for-that-key); every call is logged, because a suppressed note
// and a note that was never attempted look identical at the output (#537's untraveled-seam class).
const fakeGit = (script, calls) => (args) => {
  const key = args.join(' ')
  const n = calls.filter((c) => c.key === key).length
  calls.push({ key, n })
  const out = script(key, n, args)
  if (out instanceof Error) throw out
  return out ?? ''
}

const moved =
  (count = '8', world = {}) =>
  (key, n) => {
    const { main = TIP, unmerged = '0', branch = 'main', ahead = count } = world
    if (key === 'rev-parse HEAD') return n === 0 ? LOADED : TIP
    if (key === 'rev-parse --verify origin/main') return main
    if (key === 'symbolic-ref --short -q HEAD') return branch
    // keyed by RANGE, not by startsWith('rev-list'): the two counts answer different questions (how
    // much main lacks vs how much the tree lacks), and one number handed to both would make a merged
    // tree and an unmerged one indistinguishable in the harness - the #152 bug, rebuilt as a fixture
    if (key === `rev-list --count origin/main..${TIP}`) return unmerged
    if (key === `rev-list --count ${LOADED}..origin/main`) return ahead
    if (key.startsWith('log -1 --format=%cI')) return TIP_DATE
    return new Error(`unplanned git call: ${key}`)
  }

// the three reads that decide the #152 verdict, in the order describe() asks for them on the
// unmerged path - asserted per arm so a note produced by a DEGRADED read cannot satisfy an arm that
// thinks it measured one (#537's untraveled-seam class, which this file already guards elsewhere)
const travelled = (calls, extra = []) => {
  const keys = calls.map((c) => c.key)
  for (const k of [
    'rev-parse HEAD',
    'rev-parse --verify origin/main',
    `rev-list --count origin/main..${TIP}`,
    ...extra,
  ])
    assert.ok(keys.includes(k), `git read never traveled: ${k}`)
}

const clock = (...values) => {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)]
}

// shared by both suites: the wiring arms need the same scripted git the unit arms use
const plan = (script, now = clock(0, 15 * 60 * 1000)) => {
  const calls = []
  return { calls, currency: CodeCurrency({ git: fakeGit(script, calls), now }) }
}

describe('CodeCurrency: a long-lived runner naming the code it actually loaded (#122)', () => {
  it('stays silent while the tree has not moved - and proves the read was traveled', () => {
    const { currency, calls } = plan((key) =>
      key === 'rev-parse HEAD' ? LOADED : '',
    )
    assert.equal(currency.describe(), '')
    assert.equal(currency.loadedSha, LOADED)
    assert.ok(
      calls.some((c) => c.key === 'rev-parse HEAD'),
      'the seam was never called: a vacuous green',
    )
  })

  it('names both SHAs, the count of commits on main, the newest commit and the operator action', () => {
    const { currency } = plan(moved())
    const note = currency.describe()
    assert.ok(note.includes(`${'a'.repeat(7)} at boot`), note)
    assert.ok(note.includes(`tree now sits at ${'b'.repeat(7)}`), note)
    assert.ok(note.includes('8 commits of merged behavior landed since'), note)
    // #152: a `rev-list --count` is a COMMIT count. Calling it "merges" was how the note could print
    // "2 merges landed" about a pair whose non-merge commit was a feature commit.
    assert.ok(!note.includes('merges landed'), note)
    assert.ok(note.includes(`(newest commit ${TIP_DATE})`), note)
    assert.ok(
      note.includes('Restart the runner (page start <agent> <project>)'),
      note,
    )
    assert.ok(note.includes('advises only'), note)
    assert.ok(
      !note.includes(LOADED),
      'a 40-char SHA bloats every prompt: it must print short',
    )
  })

  it('suppresses the note when nothing can be read, and does not claim fresh', () => {
    const { currency, calls } = plan(() => new Error('git: not found'))
    assert.equal(currency.describe(), '')
    assert.equal(currency.loadedSha, '')
    assert.ok(
      calls.length > 0,
      'the throwing branch must still be the branch that ran',
    )
  })

  it('suppresses when only the current tip read fails (a half-answer is not a measurement)', () => {
    const { currency } = plan((key, n) => {
      if (key !== 'rev-parse HEAD') return new Error(`unplanned: ${key}`)
      if (n === 0) return LOADED
      throw new Error('tree went away mid-read')
    })
    assert.equal(currency.describe(), '')
  })

  it('says the count is unknown rather than inventing zero when rev-list cannot answer', () => {
    const note = plan(moved('')).currency.describe()
    assert.ok(
      note.includes('commit count unknown (git could not answer)'),
      note,
    )
    assert.ok(!note.includes('NaN'), note)
    assert.ok(!note.includes('0 merges'), note)
  })

  it('calls a sideways move a sideways move, not an empty window of merged work', () => {
    const note = plan(moved('0')).currency.describe()
    assert.ok(note.includes('so a restart would load OLDER code'), note)
    assert.ok(!note.includes('merges landed'), note)
  })

  // #152: the state that actually fired on this box. A peer checked the shared runtime tree out to an
  // OPEN PR's head; main had not moved; the note told every runner in the fleet to restart to obtain
  // "merged behavior" that did not exist. Both halves matter: the false claim AND the advice.
  it('calls a ref main does not contain UNMERGED and refuses to advise a restart (the live incident)', () => {
    const { currency, calls } = plan(moved('0', { unmerged: '2', branch: '' }))
    const note = currency.describe()
    travelled(calls, ['symbolic-ref --short -q HEAD'])
    assert.ok(note.includes('2 commits main'), note)
    assert.ok(note.includes('does NOT contain'), note)
    assert.ok(note.includes('UNMERGED work'), note)
    assert.ok(note.includes('a detached HEAD at'), note)
    assert.ok(note.includes('no merged behavior is missing'), note)
    assert.ok(note.includes('git checkout main && git pull --ff-only'), note)
    assert.ok(!note.includes('Restart the runner ('), note)
    assert.ok(!note.includes('merged behavior landed'), note)
  })

  it('says both true things at once when the tree is unmerged AND main has moved', () => {
    const { currency, calls } = plan(
      moved('3', { unmerged: '1', branch: 'feat/x' }),
    )
    const note = currency.describe()
    travelled(calls, [
      'symbolic-ref --short -q HEAD',
      `rev-list --count ${LOADED}..origin/main`,
    ])
    assert.ok(note.includes('main is 3 commits ahead of what you loaded'), note)
    assert.ok(note.includes('1 commit main'), note)
    assert.ok(note.includes('branch feat/x'), note)
    assert.ok(note.includes('restarting the runner would load it'), note)
    assert.ok(!note.includes('Restart the runner ('), note)
  })

  it('does not read an unanswered unmerged count as merged (Number("") is 0)', () => {
    const { currency, calls } = plan(moved('8', { unmerged: '' }))
    const note = currency.describe()
    travelled(calls)
    assert.ok(note.includes('could not be counted'), note)
    assert.ok(!note.includes('UNMERGED'), note)
    assert.ok(!note.includes('merged behavior landed'), note)
    assert.ok(!note.includes('Restart the runner ('), note)
  })

  it('declines to characterise the move when there is no origin/main to compare against', () => {
    const { currency } = plan(moved('8', { main: '' }))
    const note = currency.describe()
    assert.ok(
      note.includes('the merged tip could not be read (no origin/main)'),
      note,
    )
    assert.ok(
      note.includes('do not restart on the strength of this note alone'),
      note,
    )
    assert.ok(!note.includes('Restart the runner ('), note)
    assert.ok(!note.includes('merged behavior landed'), note)
  })

  it('reports process age from the injected clock, never the wall', () => {
    const { currency } = plan(moved(), clock(1_000, 1_000 + 15 * 60 * 1000))
    assert.ok(
      currency.describe().includes('running 15 min'),
      currency.describe(),
    )
  })

  it('clamps a backwards clock to 0 min instead of printing a negative age', () => {
    const { currency } = plan(moved(), clock(1_000, 0))
    assert.ok(
      currency.describe().includes('running 0 min'),
      currency.describe(),
    )
  })
})

describe('the runner composes the note into the prompt the session receives', () => {
  const backlog = [
    {
      number: 55,
      labels: [{ name: 'status:unclaimed' }, { name: 'type:task' }],
      comments: [],
    },
  ]
  const mockGithub = {
    listIssues: async (options = {}) =>
      (options.state || 'open') === 'closed' ? [] : backlog,
    listPrs: async () => [],
  }

  const capturePrompt = (currency) => {
    let captured = null
    const runner = Runner({
      github: mockGithub,
      agent: 'bravo',
      project: 'pp',
      targetPath: '/tmp/test',
      waitImpl: async () => false,
      codeCurrency: currency,
      sessionImpl: async (opts) => {
        captured = opts
        return { code: 0 }
      },
    })
    return runner.runLoop({ maxCycles: 1 }).then(() => captured?.prompt ?? null)
  }

  it('carries it when the tree moved under the process (the wiring, not the formatter)', async () => {
    const { currency } = plan(moved())
    let captured = null
    const runner = Runner({
      github: mockGithub,
      agent: 'bravo',
      project: 'pp',
      targetPath: '/tmp/test',
      waitImpl: async () => false,
      codeCurrency: currency,
      sessionImpl: async (opts) => {
        captured = opts
        return { code: 0 }
      },
    })
    const res = await runner.runLoop({ maxCycles: 1 })
    assert.ok(
      captured?.prompt,
      'no session prompt was captured: the arm measured nothing',
    )
    assert.ok(captured.prompt.includes('Code currency:'), captured.prompt)
    // box 6: the note is advice, so it must not alter the loop's own outcome
    assert.equal(res.stopped, true)
    assert.equal(res.reason, 'max_cycles_reached')
  })

  // The `page start` branch cannot be driven in-process - it builds a real GitHubClient and a real pi
  // session (no injectable seam there), so the call-site wiring gets a source-shape assert. That is
  // strictly weaker than a drive and is stated as such in the PR rather than claimed as coverage.
  it('src/cli/index.js hands the measurement to the Runner it starts', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'cli', 'index.js'),
      'utf8',
    )
    const from = src.indexOf('const runner = Runner({')
    const block = src.slice(from, src.indexOf('const maxCycles'))
    assert.ok(
      from >= 0 && block.length > 0,
      'the Runner call site moved - this pin must move with it',
    )
    assert.ok(
      /\bcodeCurrency,/.test(block),
      `start no longer wires the measurement:\n${block}`,
    )
    assert.ok(
      !/startupCurrency/.test(src),
      'the untestable startup print came back - it fires only in a race',
    )
  })

  it('leaves it out when the tree is current, while still delivering the base prompt', async () => {
    const { currency, calls } = plan((key) =>
      key === 'rev-parse HEAD' ? LOADED : '',
    )
    const prompt = await capturePrompt(currency)
    assert.ok(prompt.includes('Continue development'), prompt)
    assert.ok(!prompt.includes('Code currency:'), prompt)
    assert.ok(
      calls.length > 0,
      'the fresh arm must still read git, or it proves nothing about currency',
    )
  })

  it('resolveCyclePrompt appends it after the closure report and before steering', () => {
    const prompt = resolveCyclePrompt({
      closures: { note: 'CLOSURE-NOTE' },
      codeCurrency: 'CURRENCY-NOTE',
      steering: 'STEER',
    })
    const order = ['CLOSURE-NOTE', 'CURRENCY-NOTE', 'STEER'].map((t) =>
      prompt.indexOf(t),
    )
    assert.ok(
      order.every((i) => i >= 0),
      prompt,
    )
    assert.deepEqual(
      order,
      [...order].sort((a, b) => a - b),
      `placement drifted: ${prompt}`,
    )
  })
})
