const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync, execFileSync } = require('node:child_process')
const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

// #21: every pin in provenance.test.js drives an injected fake, and the fake is precisely what let
// two defects ship - a detached `@{u}` handed back a sha that real git can never produce, and nobody
// looked at the stderr channel at all. These pins run the real binary against real repos, so they
// cannot be satisfied by an invention: the claim under test is "git's own noise never reaches the
// reader" and "a detached review worktree at the tip is trusted".
const ROOT = join(__dirname, '..', '..')
const MODULE = join(ROOT, 'src/cli/selfcheck.js')

const quiet = { stdio: ['ignore', 'pipe', 'pipe'] }

const git = (dir, args) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', ...quiet })

const freshRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'bravo21-'))
  git(dir, ['init', '-q', '--initial-branch=main'])
  git(dir, [
    '-c',
    'user.email=probe@t',
    '-c',
    'user.name=probe',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'seed',
  ])
  return dir
}

// the child prints the verdict as well as the reading, so a state nobody evaluated cannot pass
const readIn = (dir) =>
  spawnSync(
    process.execPath,
    [
      '-e',
      `const { Provenance } = require(${JSON.stringify(MODULE)})
       const p = Provenance({ cwd: ${JSON.stringify(dir)} })
       const state = p.read()
       process.stdout.write(JSON.stringify({
         ...state,
         trusted: p.isTrusted(state),
         note: p.note(state),
       }))`,
    ],
    { encoding: 'utf8' },
  )

const stateIn = (dir) => {
  const child = readIn(dir)
  assert.equal(child.status, 0, `the reader itself failed: ${child.stderr}`)
  // the whole point of #21: git's fatal lines must never reach the terminal
  assert.equal(
    child.stderr,
    '',
    `git noise leaked to the reader: ${child.stderr}`,
  )
  const state = JSON.parse(child.stdout)
  // non-vacuity floor: the child really shelled git and got a repo back
  assert.equal(
    state.measured,
    true,
    'the fixture produced no reading, so the silence proved nothing',
  )
  return state
}

describe('real git (#21)', () => {
  it('is quiet on a branch with no upstream, and still calls it unpushed', () => {
    const dir = freshRepo()
    try {
      const state = stateIn(dir)
      assert.equal(state.branch, 'main')
      assert.equal(
        state.tipRef,
        '',
        'a branch must not fall through to origin/HEAD',
      )
      assert.match(state.note, /no upstream/)
      assert.doesNotMatch(state.note, /upstream tip/)
      assert.equal(state.trusted, false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is quiet on a detached HEAD, which has no @{u} to resolve', () => {
    const dir = freshRepo()
    try {
      git(dir, ['checkout', '-q', '--detach'])
      const state = stateIn(dir)
      assert.equal(state.branch, 'detached')
      assert.equal(
        state.trusted,
        false,
        'a repo with no remote at all cannot be confirmed',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('trusts a detached worktree that sits on the tip, with no noise, which is a review checkout', () => {
    // clone => origin/HEAD exists => the detached case resolves its tip the way #21 says it must
    const seed = freshRepo()
    const base = mkdtempSync(join(tmpdir(), 'bravo21c-'))
    const clone = join(base, 'clone')
    try {
      execFileSync('git', ['clone', '-q', seed, clone], {
        ...quiet,
        cwd: base,
        encoding: 'utf8',
      })
      git(clone, ['checkout', '-q', '--detach'])
      const state = stateIn(clone)
      assert.equal(state.branch, 'detached')
      assert.equal(state.tipRef, 'origin/HEAD')
      assert.equal(
        state.upstreamSha,
        state.sha,
        'a clone tip should equal its own HEAD',
      )
      assert.equal(
        state.trusted,
        true,
        'a review worktree at the tip must not be nagged',
      )
      assert.equal(state.note, '')
    } finally {
      rmSync(seed, { recursive: true, force: true })
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('accuses a detached worktree that is behind the tip, in one line', () => {
    const seed = freshRepo()
    const base = mkdtempSync(join(tmpdir(), 'bravo21d-'))
    const clone = join(base, 'clone')
    try {
      execFileSync('git', ['clone', '-q', seed, clone], {
        ...quiet,
        cwd: base,
        encoding: 'utf8',
      })
      git(clone, ['checkout', '-q', '--detach'])
      // advance the seed so the clone's detached HEAD is genuinely behind origin/HEAD
      git(seed, [
        '-c',
        'user.email=probe@t',
        '-c',
        'user.name=probe',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'second',
      ])
      git(clone, ['fetch', '-q', 'origin'])
      const state = stateIn(clone)
      assert.equal(state.trusted, false)
      assert.match(state.note, /^coord note: running from/)
      assert.match(state.note, /detached/)
      assert.doesNotMatch(state.note, /\n/, 'the note grew past one line')
    } finally {
      rmSync(seed, { recursive: true, force: true })
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('ignores node_modules in the repo under test, and the ignore probe is shown biting', () => {
    // #74: pi-agents had NO .gitignore at all, so `yarn install`'s node_modules/.yarn-integrity made
    // the shared runtime tree read dirty on every command. This arm can only pass in the real repo,
    // and the control keeps it from being vacuous: `git check-ignore` exits 0 for an ignored path and
    // nonzero for a tracked one, so a probe that ignores nothing would fail right here.
    const ignored = spawnSync('git', ['check-ignore', '-q', 'node_modules'], {
      cwd: ROOT,
      ...quiet,
    })
    const tracked = spawnSync('git', ['check-ignore', '-q', 'package.json'], {
      cwd: ROOT,
      ...quiet,
    })
    assert.equal(
      ignored.status,
      0,
      'node_modules is not ignored in this repo - the #74 rule did not land',
    )
    assert.notEqual(
      tracked.status,
      0,
      'the ignore probe matched everything, so the first assert proved nothing',
    )
    assert.equal(
      execFileSync('git', ['ls-files', '.gitignore'], {
        cwd: ROOT,
        encoding: 'utf8',
      }).trim(),
      '.gitignore',
      "the ignore rule is not tracked, so it cannot protect another agent's checkout",
    )
  })

  it('calls an untracked node_modules what it is, and an ignore rule is what clears it', () => {
    // A trusted tip is the substrate, so the untracked path is the ONLY variable: the clone sits on
    // its own origin/HEAD and reads clean and trusted; one untracked file flips it to untracked-only
    // AND untrusted (the gate staying strict is the claim); git's local equivalent of .gitignore -
    // .git/info/exclude, which never appears in the work tree - puts it back. That file is used
    // deliberately: writing a .gitignore INTO the fixture would add untracked dirt of its own, which
    // is the very thing under test.
    const seed = freshRepo()
    const base = mkdtempSync(join(tmpdir(), 'delta74-'))
    const clone = join(base, 'clone')
    try {
      execFileSync('git', ['clone', '-q', seed, clone], {
        ...quiet,
        cwd: base,
        encoding: 'utf8',
      })
      git(clone, ['checkout', '-q', '--detach'])
      const before = stateIn(clone)
      assert.equal(before.trusted, true, 'the substrate is not a trusted tip')
      assert.equal(before.note, '')

      mkdirSync(join(clone, 'node_modules'))
      writeFileSync(join(clone, 'node_modules', '.yarn-integrity'), '{}\n')
      const grown = stateIn(clone)
      assert.deepEqual(grown.untracked, ['node_modules/'])
      assert.equal(
        grown.dirty,
        false,
        'an untracked install dir was read as a tracked edit',
      )
      assert.equal(
        grown.trusted,
        false,
        'the gate moved: an untracked file is live code to require(), so it must stay untrusted',
      )
      assert.match(grown.note, /untracked only \(1 path\(s\): node_modules\/\)/)
      assert.doesNotMatch(
        grown.note,
        /\bdirty\b/,
        `note called it dirty: ${grown.note}`,
      )

      writeFileSync(join(clone, '.git', 'info', 'exclude'), 'node_modules\n')
      const cleared = stateIn(clone)
      assert.deepEqual(
        cleared.untracked,
        [],
        "the ignore rule did not reach git's status",
      )
      assert.equal(cleared.dirty, false)
      assert.equal(
        cleared.trusted,
        true,
        'an ignored install dir must not nag the fleet forever',
      )
      assert.equal(cleared.note, '')
    } finally {
      rmSync(seed, { recursive: true, force: true })
      rmSync(base, { recursive: true, force: true })
    }
  })
})
