const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const {
  RunnerCurrency,
  runnerIndex,
  ANNOTATOR_PATH,
} = require('../../src/cli/runner-currency')
const { Cli } = require('../../src/cli')

// #130: #122's note can only speak from a process that loaded the annotator, so the five runners booted
// before `1ce79a5` were silent about being stale - including in the session that reported a CLOSED-axis
// scan carrying OPEN-axis advice, which is text no current process can produce. These pins hold the
// census, the pid self-match that the fleet has recorded twice as an empty field in its own probe output,
// the reflog-window honesty (a SHA the process never loaded is a fabrication, not a measurement), and the
// read-only property: this tool names the restart and must never be the thing that kills a sibling.

const REF_EPOCH = 1_700_000_000_000 // 2023-11-14T22:13:20Z, arbitrary; only its position vs boot matters
const rows = (extra = {}) => ({
  [`log --diff-filter=A --format=%H --reverse -- ${ANNOTATOR_PATH}`]:
    'a'.repeat(40),
  [`log -1 --format=%ct ${'a'.repeat(40)}`]: String(REF_EPOCH / 1000),
  'reflog show --date=iso-strict --format=%H %ct HEAD': [
    `${'b'.repeat(40)} ${REF_EPOCH / 1000 + 500}`,
    `${'c'.repeat(40)} ${REF_EPOCH / 1000 + 100}`,
    `${'d'.repeat(40)} ${REF_EPOCH / 1000 - 900}`,
  ].join('\n'),
  ...extra,
})

const gitFrom = (table) => {
  const calls = []
  const git = (args) => {
    const key = args.join(' ')
    calls.push(key)
    const value = table[key]
    if (value instanceof Error) throw value
    return value ?? ''
  }
  git.calls = calls
  return git
}

// bootEpochMs 0 + starttimeTicks/100 * 1000 => boot at that epoch; `comm` deliberately carries
// parentheses to prove the parse skips the whole field rather than splitting on the first ')'
const procOf = (entries) => () => entries

const runner = (pid, verb = 'start', comm = '(page)') => ({
  pid,
  argv: [
    'node',
    '/home/charles/sullux/pi-agents/bin/page',
    verb,
    'Charlie',
    'pp',
  ],
  starttimeTicks: 0,
  bootEpochMs: 0,
  comm,
})

describe('runner currency census (#130)', () => {
  it('splits runners by the annotator commit and never counts itself', () => {
    const stale = { ...runner(101), bootEpochMs: REF_EPOCH - 60_000 }
    const fresh = { ...runner(202), bootEpochMs: REF_EPOCH + 60_000 }
    const mine = runner(999)
    const rc = RunnerCurrency({
      git: gitFrom(rows()),
      proc: procOf([stale, fresh, mine]),
      selfPid: 999,
    })
    const state = rc.census()
    assert.equal(state.measured, true)
    assert.equal(
      state.runners.length,
      2,
      'the querying process was counted as a runner',
    )
    const byPid = Object.fromEntries(state.runners.map((r) => [r.pid, r]))
    assert.equal(byPid[101].state, 'cannot-warn')
    assert.equal(byPid[202].state, 'current')
  })

  it('names the restart remedy and the reference commit in the rendered line', () => {
    const rc = RunnerCurrency({
      git: gitFrom(rows()),
      proc: procOf([{ ...runner(101), bootEpochMs: REF_EPOCH - 1 }]),
      selfPid: 1,
    })
    const text = rc.describe()
    assert.match(text, /CANNOT emit the currency note/)
    assert.match(text, /restart the runner/)
    assert.match(text, /aaaaaaa/, `the reference sha is missing from: ${text}`)
  })

  it('reports the loaded commit with the merge count for a runner that CAN warn', () => {
    const table = rows()
    table[`rev-list --count ${'c'.repeat(40)}..origin/main`] = '7'
    const rc = RunnerCurrency({
      git: gitFrom(table),
      proc: procOf([{ ...runner(202), bootEpochMs: REF_EPOCH + 200_000 }]),
      selfPid: 1,
    })
    const text = rc.describe()
    assert.match(text, /loaded c{7} \(7 merges behind\)/, `rendered: ${text}`)
  })

  it('prints the reflog-window sentence instead of a fabricated sha', () => {
    const rc = RunnerCurrency({
      git: gitFrom({
        ...rows(),
        'reflog show --date=iso-strict --format=%H %ct HEAD': `${'b'.repeat(40)} ${REF_EPOCH / 1000 + 9000}`,
      }),
      proc: procOf([{ ...runner(303), bootEpochMs: REF_EPOCH + 1000 }]),
      selfPid: 1,
    })
    assert.match(rc.describe(), /older than the retained reflog/)
  })

  it('reads field 22 past a comm field that contains parentheses', () => {
    const statLike = { ...runner(404), comm: '(odd (nested) name)' }
    const rc = RunnerCurrency({
      git: gitFrom(rows()),
      proc: procOf([statLike]),
      selfPid: 1,
    })
    assert.equal(
      rc.census().runners[0].pid,
      404,
      'the census dropped a runner it should have kept',
    )
  })

  it('is read-only: every git argv is a listed read and no kill verb is reachable', () => {
    const git = gitFrom(rows())
    const rc = RunnerCurrency({
      git,
      proc: procOf([runner(101), runner(202)]),
      selfPid: 1,
    })
    rc.describe()
    const reads = [
      'log ',
      'reflog ',
      'rev-list ',
      'rev-parse ',
      'status ',
      'remote ',
    ]
    const offenders = git.calls.filter(
      (key) => !reads.some((prefix) => key.startsWith(prefix)),
    )
    assert.deepEqual(
      offenders,
      [],
      `a mutating git call reached the shell: ${JSON.stringify(offenders)}`,
    )
    assert.equal(
      git.calls.some((key) =>
        /\b(kill|reset|checkout|clean|commit|push|tag|stash)\b/.test(key),
      ),
      false,
      'the census touched the tree or a process',
    )
  })

  it('degrades to silence when git cannot answer, and does not crash', () => {
    const boom = new Error('not a repo')
    const rc = RunnerCurrency({
      git: gitFrom({
        [`log --diff-filter=A --format=%H --reverse -- ${ANNOTATOR_PATH}`]:
          boom,
      }),
      proc: procOf([runner(101)]),
      selfPid: 1,
    })
    assert.equal(rc.describe(), '')
    assert.equal(rc.census().measured, false)
  })

  it('a shell command line that merely contains the phrase is not a runner', () => {
    assert.equal(
      runnerIndex(['/bin/bash', '-c', 'echo "page start Charlie pp"']),
      -1,
    )
    assert.equal(runnerIndex(['/bin/sh', '-c', 'pgrep -f page start']), -1)
    assert.ok(runnerIndex(['node', '/x/bin/page', 'start', 'A', 'pp']) >= 0)
    assert.ok(runnerIndex(['node', '/x/bin/page', 'run', 'A', 'pp']) >= 0)
    assert.equal(runnerIndex(['node', '/x/bin/page', 'coord', 'board']), -1)
  })
})

describe('runners verb is wired (#130)', () => {
  const harness = (runnerCurrency) => {
    const out = []
    const err = []
    const cli = Cli({
      runnerCurrency,
      github: { repo: 'Sullux/test-repo' },
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
    })
    return { out, err, run: (argv) => cli.run(argv) }
  }

  it('the verb travels the seam and prints the census, proving the call site', async () => {
    const calls = []
    const fake = {
      describe: () => {
        calls.push('describe')
        return 'RUNNER-CENSUS-TEXT'
      },
      census: () => ({ measured: true, runners: [] }),
    }
    const h = harness(fake)
    const code = await h.run(['runners'])
    assert.deepEqual(calls, ['describe'], 'the seam was never traveled')
    assert.ok(
      h.out.includes('RUNNER-CENSUS-TEXT'),
      `stdout was ${JSON.stringify(h.out)}`,
    )
    assert.equal(code, 0)
  })

  it('an empty census says so instead of printing nothing', async () => {
    const h = harness({
      describe: () => '',
      census: () => ({ measured: true, runners: [] }),
    })
    const code = await h.run(['runners'])
    assert.equal(code, 0)
    assert.ok(
      h.out.some((line) => /no live runners|nothing to report/.test(line)),
      `stdout was ${JSON.stringify(h.out)}`,
    )
  })
})
