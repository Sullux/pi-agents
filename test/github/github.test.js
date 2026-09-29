const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { GitHubClient, resolveRepoFromRemote } = require('../../src/github')

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
