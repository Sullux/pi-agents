const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')
const { Provenance } = require('../../src/cli/selfcheck')
const { Cli } = require('../../src/cli')

// #18: this repo has no build step and no node_modules, so the shared checkout IS the program every
// agent runs, and a sibling's branch or mid-probe edit silently becomes everyone's coord. The reading
// is what was missing. These pins hold three properties at once: the note fires for every way a tree
// can diverge, it NEVER fires on a clean tree at the tip (otherwise agents learn to ignore it), and it
// can neither pollute stdout nor change an exit code nor take down the command it is reporting on -
// which is precisely the outage shape this issue was filed from.

// key is the exact argv the module reads, so a rename on either side goes red instead of silently
// falling through to ''
const readings = (rows) => {
  const calls = []
  const git = (args) => {
    const key = args.join(' ')
    calls.push(key)
    const value = rows[key]
    if (value instanceof Error) throw value
    return value ?? ''
  }
  git.calls = calls
  return git
}

const BASE = {
  'rev-parse --short HEAD': 'abc1234',
  'symbolic-ref --short -q HEAD': 'main',
  'status --porcelain': '',
  'rev-parse --short @{u}': 'abc1234',
  'rev-list --left-right --count @{u}...HEAD': '0\t0',
}

const at = (over) =>
  Provenance({ cwd: '/fake/repo', git: readings({ ...BASE, ...over }) })

describe('Provenance read (#18)', () => {
  it('trusts a clean tree sitting exactly on the upstream tip', () => {
    const p = at({})
    assert.equal(p.isTrusted(), true)
    // the control case: nothing is printed, so the note keeps meaning something
    assert.equal(p.note(), '')
  })

  it('names each way a tree can diverge, on one greppable line', () => {
    const cases = [
      ['dirty worktree', { 'status --porcelain': 'M src/x.js' }, /dirty/],
      [
        'branch not main',
        { 'rev-parse --short HEAD': 'def5678' },
        /def5678 vs abc1234/,
      ],
      [
        'behind the tip',
        { 'rev-list --left-right --count @{u}...HEAD': '3\t0' },
        /-3/,
      ],
      [
        'ahead of the tip',
        { 'rev-list --left-right --count @{u}...HEAD': '0\t2' },
        /\+2/,
      ],
      [
        'unpushed branch',
        { 'rev-parse --short @{u}': Error('fatal: no upstream') },
        /no upstream/,
      ],
    ]
    for (const [label, over, expected] of cases) {
      const note = at(over).note()
      assert.match(note, /^coord note: /, `${label}: note lost its prefix`)
      assert.match(
        note,
        expected,
        `${label}: note did not name the divergence -> ${note}`,
      )
      assert.doesNotMatch(note, /\n/, `${label}: note grew past one line`)
      assert.match(note, /\/fake\/repo/, `${label}: note omitted the tree path`)
    }
  })

  it('never calls an unpushed branch the upstream tip', () => {
    // 'upstream tip' here would be a false reassurance, the exact wording a mid-probe tree needs
    // to look legitimate; this assert is the regression pin for a bug caught while writing the note.
    // The fake THROWS, as real git does, rather than handing back an empty string
    const note = at({
      'rev-parse --short @{u}': Error('fatal: no upstream configured'),
    }).note()
    assert.doesNotMatch(note, /upstream tip/)
    assert.match(note, /no upstream/)
  })

  it('trusts a detached HEAD when it is the merged tip', () => {
    // #21: the old row handed back a sha for `@{u}`, which real git CANNOT do when detached - so the
    // pin passed against a state that cannot occur while production accused every review worktree.
    // A detached tree resolves its tip through origin/HEAD instead.
    const p = Provenance({
      cwd: '/fake/repo',
      git: readings({
        ...BASE,
        'symbolic-ref --short -q HEAD': '',
        'rev-parse --short @{u}': Error(
          'fatal: HEAD does not point to a branch',
        ),
        'rev-parse --short origin/HEAD': 'abc1234',
        'rev-list --left-right --count origin/HEAD...HEAD': '0\t0',
      }),
    })
    assert.equal(p.read().branch, 'detached')
    assert.equal(p.read().tipRef, 'origin/HEAD')
    assert.equal(p.isTrusted(), true)
    assert.equal(p.note(), '')
  })

  it('accuses a detached tree that sits behind the tip, and says so in one line', () => {
    const p = Provenance({
      cwd: '/fake/repo',
      git: readings({
        ...BASE,
        'symbolic-ref --short -q HEAD': '',
        'rev-parse --short @{u}': Error(
          'fatal: HEAD does not point to a branch',
        ),
        'rev-parse --short origin/HEAD': 'def5678',
        'rev-list --left-right --count origin/HEAD...HEAD': '4\t0',
      }),
    })
    assert.equal(p.isTrusted(), false)
    assert.match(p.note(), /detached/)
    assert.match(p.note(), /abc1234 vs def5678/)
  })

  it('falls back to origin/main when origin/HEAD is missing, but never for a branch', () => {
    const detached = Provenance({
      cwd: '/fake/repo',
      git: readings({
        ...BASE,
        'symbolic-ref --short -q HEAD': '',
        'rev-parse --short @{u}': Error(
          'fatal: HEAD does not point to a branch',
        ),
        'rev-parse --short origin/HEAD': Error('fatal: ambiguous argument'),
        'rev-parse --short origin/main': 'abc1234',
      }),
    })
    assert.equal(detached.read().tipRef, 'origin/main')
    assert.equal(detached.isTrusted(), true)
    // the branch path must not reach the fallback, or an unpushed branch reads as being at the tip
    const unpushed = Provenance({
      cwd: '/fake/repo',
      git: readings({
        ...BASE,
        'rev-parse --short @{u}': Error(
          'fatal: no upstream configured for branch',
        ),
        'rev-parse --short origin/HEAD': 'abc1234',
      }),
    })
    assert.equal(unpushed.read().tipRef, '')
    assert.match(unpushed.note(), /no upstream/)
  })

  it('travels the injected git seam with the exact reads it claims', () => {
    const git = readings({ ...BASE })
    Provenance({ cwd: '/fake/repo', git }).read()
    assert.deepEqual(git.calls, [
      'rev-parse --short HEAD',
      'symbolic-ref --short -q HEAD',
      'rev-parse --short @{u}',
      'rev-list --left-right --count @{u}...HEAD',
      'status --porcelain',
    ])
  })

  it('degrades to silence when git throws, rather than becoming the new outage', () => {
    const boom = Error('git: command not found')
    const git = readings(
      Object.fromEntries(Object.keys(BASE).map((key) => [key, boom])),
    )
    const p = Provenance({ cwd: '/x', git })
    assert.equal(p.isTrusted(), false)
    assert.equal(p.note(), '')
    assert.match(p.describe(), /unknown/)
    assert.doesNotMatch(p.describe(), /trust      merged tip/)
    assert.ok(git.calls.length > 0, 'the guard never tried to measure')
  })

  it('reports a non-repo the same way: measured=false, no note', () => {
    const p = Provenance({ cwd: '/not/a/repo', git: readings({}) })
    assert.equal(p.read().measured, false)
    assert.equal(p.note(), '')
  })
})

const fakeCoord = { board: async () => 'BOARD-OUTPUT' }

const harness = (provenance) => {
  const out = []
  const err = []
  const cli = Cli({
    coordFactory: () => fakeCoord,
    provenance,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  })
  return { out, err, run: (argv) => cli.run(argv) }
}

describe('coord dispatch (#18)', () => {
  it('puts the advisory on stderr and leaves stdout and the exit code alone', async () => {
    const h = harness({
      note: () => 'coord note: TEST NOTE',
      describe: () => 'D',
    })
    const code = await h.run(['coord', 'board'])
    assert.equal(code, 0)
    assert.deepEqual(h.out, ['BOARD-OUTPUT'])
    assert.deepEqual(h.err, ['coord note: TEST NOTE'])
  })

  it('cannot take down the command it is reporting on, even if it throws', async () => {
    // the asymmetry is the design: the advisory is subordinate, so a defect in it must not repeat
    // the #18 outage where one bad line in the shared tree killed every agent's board
    const h = harness({
      note: () => {
        throw Error('provenance blew up')
      },
      describe: () => 'D',
    })
    assert.equal(await h.run(['coord', 'board']), 0)
    assert.deepEqual(h.out, ['BOARD-OUTPUT'])
  })

  it('answers `coord provenance` from describe() without doubling the note', async () => {
    const h = harness({
      note: () => 'coord note: TEST NOTE',
      describe: () => 'path /x\ntrust x',
    })
    const code = await h.run(['coord', 'provenance'])
    assert.equal(code, 0)
    assert.deepEqual(h.out, ['path /x\ntrust x'])
    assert.deepEqual(h.err, [])
  })

  it('still reports an unknown verb as a usage error, note and all', async () => {
    const h = harness({
      note: () => 'coord note: TEST NOTE',
      describe: () => 'D',
    })
    assert.equal(await h.run(['coord', 'frobnicate']), 1)
    // measured, not assumed: an unknown coord sub falls through to printHelp(), which writes to the
    // GLOBAL console.log rather than the injected sink, then returns 1. What this pins is that the
    // advisory neither hijacks that exit code nor leaks onto stdout.
    assert.deepEqual(h.err, ['coord note: TEST NOTE'])
    assert.deepEqual(h.out, [])
  })

  it('reads the real binary for the default wiring, not only injected fakes', () => {
    const root = join(__dirname, '..', '..')
    const text = execFileSync(
      process.execPath,
      [join(root, 'bin', 'page'), 'coord', 'provenance'],
      {
        cwd: root,
        encoding: 'utf8',
      },
    )
    // shape only: the sha and path are mutable state this test must not hardcode
    assert.match(text, /^path\s+\S+/m)
    assert.match(text, /^sha\s+[0-9a-f]{7,}$/m)
    assert.match(text, /^trust      (merged tip|NOT the merged tip)$/m)
  })
})
