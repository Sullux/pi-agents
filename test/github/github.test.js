const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const {
  GitHubClient,
  resolveRepoFromRemote,
  GH_MAX_BUFFER,
  NODE_DEFAULT_MAX_BUFFER,
} = require('../../src/github')

describe('GitHubClient', () => {
  it('resolveRepoFromRemote parses SSH, HTTPS, and git suffix URLs', () => {
    assert.equal(
      resolveRepoFromRemote('git@github.com:Sullux/pitcairn-portal.git'),
      'Sullux/pitcairn-portal',
    )
    assert.equal(
      resolveRepoFromRemote('https://github.com/Sullux/pitcairn-portal.git'),
      'Sullux/pitcairn-portal',
    )
    assert.equal(
      resolveRepoFromRemote('https://github.com/Sullux/pitcairn-portal'),
      'Sullux/pitcairn-portal',
    )
  })

  it('listIssues executes gh issue list with correct json flags', async () => {
    let capturedArgs = []
    const mockExec = (cmd, args) => {
      capturedArgs = [cmd, ...args]
      return JSON.stringify([{ number: 1, title: 'test issue' }])
    }

    const client = GitHubClient({
      execFile: mockExec,
      repo: 'Sullux/pitcairn-portal',
    })
    const issues = await client.listIssues()

    assert.equal(issues.length, 1)
    assert.equal(issues[0].title, 'test issue')
    assert.equal(capturedArgs[0], 'gh')
    assert.ok(capturedArgs.includes('--repo'))
    assert.ok(capturedArgs.includes('Sullux/pitcairn-portal'))
  })
})

// The pitcairn coordination hub (issue #4) grew to 1,051,909 bytes across 783 comments. Node's
// execFileSync default maxBuffer is 1,048,576, and exceeding it THROWS ENOBUFS rather than
// truncating - so `page coord board` died outright for every agent on the box, including the
// viewIssue re-fetch that withFullTimelines performs precisely to avoid a truncated timeline.
const HUB_PAYLOAD_BYTES = 1051909

describe('gh output buffering', () => {
  it('passes a maxBuffer above the Node default on every child process it spawns', async () => {
    const options = []
    const mockExec = (cmd, args, opts) => {
      options.push([cmd, opts])
      return cmd === 'git' ? 'git@github.com:Sullux/pitcairn-portal.git' : '[]'
    }

    const client = GitHubClient({ execFile: mockExec })
    await client.listIssues()

    // Both spawn sites, not just the gh one: the git-remote probe is small today but shares the
    // helper, and a pin on one site only would let the other regress silently.
    assert.ok(
      options.length >= 1,
      `expected a spawn, captured ${options.length}`,
    )
    for (const [cmd, opts] of options) {
      assert.equal(
        opts?.maxBuffer,
        GH_MAX_BUFFER,
        `${cmd} was spawned without the raised maxBuffer - it would ENOBUFS past 1MB`,
      )
    }
    assert.ok(
      GH_MAX_BUFFER > NODE_DEFAULT_MAX_BUFFER,
      'the raised ceiling must actually exceed the default it replaces',
    )
    assert.ok(
      GH_MAX_BUFFER > HUB_PAYLOAD_BYTES,
      'the ceiling must clear the payload that broke it',
    )
  })

  it('the default really does throw at the hub payload size, and the raised ceiling does not', () => {
    const emit = [
      '-e',
      `process.stdout.write('x'.repeat(${HUB_PAYLOAD_BYTES}))`,
    ]

    // RED arm: reproduces the production failure at the production byte count. Without this the
    // constant above is an unexercised number.
    let threw = ''
    try {
      execFileSync('node', emit, { encoding: 'utf8' })
    } catch (e) {
      threw = e.code || e.message
    }
    assert.equal(
      threw,
      'ENOBUFS',
      'the 1MB default must fail at 1,051,909 bytes or this pins nothing',
    )

    // GREEN arm: the same payload through the shipped constant.
    const out = execFileSync('node', emit, {
      encoding: 'utf8',
      maxBuffer: GH_MAX_BUFFER,
    })
    assert.equal(
      out.length,
      HUB_PAYLOAD_BYTES,
      'the full payload must arrive, not a truncated prefix',
    )
  })
})

// #41: from a directory with no .git, `page coord hub "..."` exited 1 having posted nothing, and
// its last line was `Error: Command failed: gh issue comment 4 --body <the entire message>`. The
// real cause was three lines above it. These arms pin that the probe is blamed, that the payload
// never echoes, and that a refusal cannot be satisfied by a stray environment variable.
const SECRET_BODY = 'SENSITIVE-HUB-BODY-DO-NOT-ECHO '.repeat(9)

const probeThrows = (calls = []) => (cmd, args) => {
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
      const client = GitHubClient({ execFile: probeThrows(), cwd: '/nope' })
      try {
        client.runGh(['issue', 'comment', '4', '--body', SECRET_BODY])
        assert.fail('expected a throw')
      } catch (err) {
        assert.ok(
          !err.message.includes(SECRET_BODY),
          'the whole body leaked into the error text',
        )
        assert.ok(
          !err.message.includes('SENSITIVE-HUB-BODY'),
          'a fragment of the body leaked into the error text',
        )
      }
    }))

  it('spawns only the probe when there is no repo - gh is never reached', () =>
    withCleanRepoEnv(() => {
      const calls = []
      const client = GitHubClient({ execFile: probeThrows(calls), cwd: '/nope' })
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
        execFile: (cmd) => (cmd === 'git' ? '/srv/repos/local-mirror.git' : '{}'),
        cwd: '/x',
      })
      try {
        client.runGh(['issue', 'view', '4'])
        assert.fail('expected a throw')
      } catch (err) {
        assert.match(err.message, /not a GitHub origin/)
        assert.match(err.message, /\/srv\/repos\/local-mirror\.git/)
      }
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
      assert.equal(calls.length, 1, 'the probe must not run when the env names the repo')
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
        execFile: (cmd) => (cmd === 'git' ? (() => { throw new Error('fatal: not a git repository') })() : '[]'),
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
      const client = GitHubClient({ execFile: () => '[]', repo: 'opt/wins', cwd: '/nope' })
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
      try {
        client.runGh(['issue', 'comment', '4', '--body', SECRET_BODY])
        assert.fail('expected a throw')
      } catch (err) {
        assert.match(err.message, /gh issue comment failed against Sullux\/pi-agents/)
        assert.match(err.message, /Issue not found \(HTTP 422\)/)
        assert.ok(
          !err.message.includes(SECRET_BODY),
          'the body leaked into a gh-failure message too',
        )
        assert.match(
          err.message,
          new RegExp(`--body <${SECRET_BODY.length} chars redacted>`),
          'the argv must stay countable without being readable',
        )
      }
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
      try {
        client.runGh(['issue', 'edit', '4', '--body', 'tiny'])
        assert.fail('expected a throw')
      } catch (err) {
        assert.ok(!err.message.includes('--body tiny'), 'short bodies must redact too')
        assert.match(err.message, /--body <4 chars redacted>/)
      }
    }))
})
