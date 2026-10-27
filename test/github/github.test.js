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
