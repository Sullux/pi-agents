const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync, execFileSync } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
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
})
