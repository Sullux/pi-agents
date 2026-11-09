const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')
const { Provenance } = require('../../src/cli/selfcheck')
const { Cli } = require('../../src/cli')

// #18: this repo has no build step, and `which page` resolves straight into the shared checkout, so
// the tree IS the program every agent runs - a sibling's branch or mid-probe edit silently becomes
// everyone's coord. The reading is what was missing. These pins hold three properties at once: the
// note fires for every way a tree can diverge, it NEVER fires on a clean tree at the tip (otherwise
// agents learn to ignore it), and it can neither pollute stdout nor change an exit code nor take
// down the command it is reporting on - which is precisely the outage shape this issue was filed
// from. #74 later corrected the header's "no node_modules" claim: running yarn here leaves
// node_modules/.yarn-integrity, and the repo had no .gitignore, so the tree read dirty forever.

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

// #74: the fleet's shared runtime tree read `dirty` forever, because `dirty` meant "porcelain said
// anything" and an untracked node_modules/ is what `yarn install` leaves in a repo with no
// .gitignore. These arms hold the split - and the part that matters most is that the GATE did not
// move: untracked-only is still untrusted, because require() resolves from the working tree, so an
// untracked src file is live code. Only the wording got honest.
describe('tracked dirt vs untracked paths (#74)', () => {
  it('names an untracked-only tree as untracked, never as dirty, and still refuses trust', () => {
    // BASE is already at the upstream tip, so the ONLY thing that can untrust this tree is the
    // untracked path - if the gate had been relaxed, trusted would flip true and this arm would fail
    const p = at({ 'status --porcelain': '?? node_modules/' })
    const state = p.read()
    assert.equal(state.dirty, false, 'an untracked path was still called dirty')
    assert.deepEqual(state.untracked, ['node_modules/'])
    assert.equal(
      p.isTrusted(),
      false,
      'the gate moved: untracked-only must stay untrusted',
    )
    assert.match(p.note(), /untracked only \(1 path\(s\): node_modules\/\)/)
    assert.doesNotMatch(p.note(), /dirty/, `note still said dirty: ${p.note()}`)
    assert.match(p.describe(), /^worktree   untracked: 1$/m)
  })

  it('keeps calling a tracked edit dirty, and reports untracked paths riding along', () => {
    const p = at({
      'status --porcelain': ' M src/coord/index.js\n?? node_modules/',
    })
    const state = p.read()
    assert.equal(state.dirty, true, 'a tracked edit stopped being dirty')
    assert.deepEqual(state.untracked, ['node_modules/'])
    assert.match(p.note(), /dirty \+1 untracked/)
    assert.doesNotMatch(p.note(), /untracked only/)
    assert.match(p.describe(), /^worktree   dirty \(\+1 untracked\)$/m)
  })

  it('still calls a tracked-only tree plain dirty - the old wording is unchanged', () => {
    const p = at({ 'status --porcelain': ' M src/x.js' })
    assert.equal(p.read().dirty, true)
    assert.deepEqual(p.read().untracked, [])
    assert.match(p.note(), /dirty/)
    assert.doesNotMatch(p.note(), /untracked/)
    assert.match(p.describe(), /^worktree   dirty$/m)
  })

  it('previews three paths and counts the rest, in one line, so a big list cannot bury the note', () => {
    const p = at({
      'status --porcelain': [
        '?? a/',
        '?? b.js',
        '?? c.js',
        '?? d.js',
        '?? e.js',
      ].join('\n'),
    })
    const note = p.note()
    assert.equal(p.read().untracked.length, 5)
    assert.match(
      note,
      /untracked only \(5 path\(s\): a\/, b.js, c.js, \+2 more\)/,
    )
    assert.doesNotMatch(note, /\n/, 'the note grew past one line')
    assert.ok(!note.includes('e.js'), 'the preview leaked past its cap')
  })

  it('splits the dirt without adding a git read - the seam list is the whole claim', () => {
    const git = readings({ ...BASE, 'status --porcelain': '?? node_modules/' })
    Provenance({ cwd: '/fake/repo', git }).read()
    // the split is derived from the SAME porcelain answer; a second `status` call would double every
    // spawn in a module whose header promises each reading is individually survivable
    assert.deepEqual(git.calls, [
      'rev-parse --short HEAD',
      'symbolic-ref --short -q HEAD',
      'rev-parse --short @{u}',
      'rev-list --left-right --count @{u}...HEAD',
      'status --porcelain',
    ])
  })
})

const fakeCoord = { board: async () => 'BOARD-OUTPUT' }
const harness = (provenance) => {
  const out = []
  const err = []
  const cli = Cli({
    coordFactory: () => fakeCoord,
    // #23 added the `github` seam. Injecting it keeps these pins off the real
    // `git remote get-url origin` spawn, which used to run for every one of them because nothing
    // printed a repo before, so nobody had to control which one it resolved.
    github: { repo: 'Sullux/test-repo' },
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
    assert.deepEqual(h.out, ['path /x\ntrust x\ncoord repo  Sullux/test-repo'])
    assert.deepEqual(h.err, [])
  })

  it('still reports an unknown verb as a usage error, note and all', async () => {
    const h = harness({
      note: () => 'coord note: TEST NOTE',
      describe: () => 'D',
    })
    assert.equal(await h.run(['coord', 'frobnicate']), 1)
    // #19 lifted the weakening that lived here. printHelp() used to write to the GLOBAL console.log,
    // so this arm could only pin that the injected sink stayed empty - a true statement about a
    // render nobody could see. The usage text now arrives in the sink, so the assertion is positive:
    // the fall-through is observable in-process, the advisory stays on stderr, the exit code stays 1.
    assert.deepEqual(h.err, ['coord note: TEST NOTE'])
    assert.equal(
      h.out.length,
      1,
      'the usage fall-through wrote a different number of lines',
    )
    assert.match(
      h.out[0],
      /Usage: page <command>/,
      'the unknown verb no longer renders usage into the injected sink',
    )
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
