const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { GitHubClient } = require('../../src/github')

// #41: from a directory with no .git, `page coord hub "..."` exited 1 having posted nothing, and
// its last line was `Error: Command failed: gh issue comment 4 --body <the entire message>`. The
// real cause was three lines above it. These arms pin that the probe is blamed, that the payload
// never echoes, and that a refusal cannot be satisfied by a stray environment variable.
const SECRET_BODY = 'SENSITIVE-HUB-BODY-DO-NOT-ECHO '.repeat(9)

const probeThrows =
  (calls = []) =>
  (cmd, args) => {
    calls.push([cmd, (args || []).join(' ')])
    if (cmd === 'git') {
      const err = new Error('Command failed: git remote get-url origin')
      err.stderr =
        'fatal: not a git repository (or any of the parent directories): .git'
      throw err
    }
    return '{}'
  }

// The arms must not inherit a repo from the operator's shell: COORD_REPO/GH_REPO are resolution
// sources, so an ambient value would make a refusal arm pass or fail for the wrong reason.
const withCleanRepoEnv = (fn) => {
  const saved = {
    COORD_REPO: process.env.COORD_REPO,
    GH_REPO: process.env.GH_REPO,
  }
  delete process.env.COORD_REPO
  delete process.env.GH_REPO
  try {
    return fn()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

// Returns the thrown message, or null when nothing threw. An assert.fail placed in the same try as
// the call is caught by that try's own handler, so the arm would then judge the AssertionError's
// text instead of the client's - which is how a vacuous pass gets published as coverage.
const captureThrow = (fn) => {
  try {
    fn()
  } catch (err) {
    return err?.message ?? String(err)
  }
  return null
}

describe('repo resolution and error attribution (#41)', () => {
  it('names the git probe as the cause, not the gh call', () =>
    withCleanRepoEnv(() => {
      const client = GitHubClient({
        execFile: probeThrows(),
        cwd: '/home/charles/agents/Bravo',
      })
      assert.equal(client.repo, '', 'the display value must stay readable')
      let message = ''
      try {
        client.runGh(['issue', 'comment', '4', '--body', SECRET_BODY])
      } catch (err) {
        message = err.message
      }
      assert.ok(message, 'expected a throw, got none')
      assert.match(message, /git remote get-url origin failed/)
      assert.match(
        message,
        /fatal: not a git repository/,
        'the probe own text must survive',
      )
      assert.match(message, /nothing was sent to GitHub/)
      assert.match(message, /\/home\/charles\/agents\/Bravo/, 'cwd is named')
    }))

  it('the refusal cannot be satisfied by echoing the payload', () =>
    withCleanRepoEnv(() => {
      const calls = []
      const client = GitHubClient({
        execFile: probeThrows(calls),
        cwd: '/nope',
      })
      // The throw is captured, not asserted inside the try: an assert.fail in that try is caught
      // by its own handler, so pre-fix code that simply returned would pass this arm vacuously.
      let message = null
      try {
        client.runGh(['issue', 'comment', '4', '--body', SECRET_BODY])
      } catch (err) {
        message = err.message
      }
      assert.ok(message !== null, 'expected a throw, got none')
      assert.ok(
        !message.includes(SECRET_BODY),
        'the whole body leaked into the error text',
      )
      assert.ok(
        !message.includes('SENSITIVE-HUB-BODY'),
        'a fragment of the body leaked into the error text',
      )
    }))

  it('spawns only the probe when there is no repo - gh is never reached', () =>
    withCleanRepoEnv(() => {
      const calls = []
      const client = GitHubClient({
        execFile: probeThrows(calls),
        cwd: '/nope',
      })
      try {
        client.runGh(['issue', 'comment', '4', '--body', SECRET_BODY])
      } catch {}
      assert.deepEqual(
        calls,
        [['git', 'remote get-url origin']],
        'the refusal must precede the gh spawn, or "nothing was sent" is a lie',
      )
    }))

  it('quotes an unusable remote answer instead of swallowing it', () =>
    withCleanRepoEnv(() => {
      const client = GitHubClient({
        execFile: (cmd) =>
          cmd === 'git' ? '/srv/repos/local-mirror.git' : '{}',
        cwd: '/x',
      })
      const message = captureThrow(() => client.runGh(['issue', 'view', '4']))
      assert.ok(message !== null, 'expected a throw, got none')
      assert.match(message, /not a GitHub origin/)
      assert.match(message, /\/srv\/repos\/local-mirror\.git/)
    }))

  it('honors COORD_REPO when the probe would fail', () => {
    const saved = process.env.COORD_REPO
    process.env.COORD_REPO = 'Sullux/pi-agents'
    try {
      const calls = []
      const client = GitHubClient({
        execFile: (cmd, args) => {
          calls.push([cmd, (args || []).join(' ')])
          return '[]'
        },
        cwd: '/nope',
      })
      client.runGh(['issue', 'list'])
      assert.equal(
        calls.length,
        1,
        'the probe must not run when the env names the repo',
      )
      assert.deepEqual(calls[0], ['gh', 'issue list --repo Sullux/pi-agents'])
    } finally {
      if (saved === undefined) delete process.env.COORD_REPO
      else process.env.COORD_REPO = saved
    }
  })

  it('honors GH_REPO, because gh itself reads it', () => {
    const saved = process.env.GH_REPO
    process.env.GH_REPO = 'Sullux/other'
    try {
      const client = GitHubClient({
        execFile: (cmd) =>
          cmd === 'git'
            ? (() => {
                throw new Error('fatal: not a git repository')
              })()
            : '[]',
        cwd: '/nope',
      })
      assert.equal(client.repo, 'Sullux/other')
    } finally {
      if (saved === undefined) delete process.env.GH_REPO
      else process.env.GH_REPO = saved
    }
  })

  it('the repo option outranks both env sources', () => {
    const saved = [process.env.COORD_REPO, process.env.GH_REPO]
    process.env.COORD_REPO = 'from/coord'
    process.env.GH_REPO = 'from/gh'
    try {
      const client = GitHubClient({
        execFile: () => '[]',
        repo: 'opt/wins',
        cwd: '/nope',
      })
      assert.equal(client.repo, 'opt/wins')
    } finally {
      ;['COORD_REPO', 'GH_REPO'].forEach((key, i) => {
        if (saved[i] === undefined) delete process.env[key]
        else process.env[key] = saved[i]
      })
    }
  })

  it('a gh failure names verb and repo, keeps the argv length, drops the content', () =>
    withCleanRepoEnv(() => {
      const client = GitHubClient({
        execFile: (cmd) => {
          if (cmd === 'git') return 'git@github.com:Sullux/pi-agents.git'
          const err = new Error('Command failed: gh issue comment')
          err.stderr = 'gh: Issue not found (HTTP 422)'
          throw err
        },
        cwd: '/x',
      })
      const message = captureThrow(() =>
        client.runGh(['issue', 'comment', '4', '--body', SECRET_BODY]),
      )
      assert.ok(message !== null, 'expected a throw, got none')
      assert.match(message, /gh issue comment failed against Sullux\/pi-agents/)
      assert.match(message, /Issue not found \(HTTP 422\)/)
      assert.ok(
        !message.includes(SECRET_BODY),
        'the body leaked into a gh-failure message too',
      )
      assert.match(
        message,
        new RegExp(`--body <${SECRET_BODY.length} chars redacted>`),
        'the argv must stay countable without being readable',
      )
    }))

  it('a short body is still redacted - the guard is not length-conditional', () =>
    withCleanRepoEnv(() => {
      const client = GitHubClient({
        execFile: (cmd) => {
          if (cmd === 'git') return 'git@github.com:Sullux/pi-agents.git'
          const err = new Error('Command failed')
          err.stderr = 'gh: boom'
          throw err
        },
        cwd: '/x',
      })
      const message = captureThrow(() =>
        client.runGh(['issue', 'edit', '4', '--body', 'tiny']),
      )
      assert.ok(message !== null, 'expected a throw, got none')
      assert.ok(
        !message.includes('--body tiny'),
        'short bodies must redact too',
      )
      assert.match(message, /--body <4 chars redacted>/)
    }))
})
