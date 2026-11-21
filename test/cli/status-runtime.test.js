const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Cli } = require('../../src/cli')
const { RuntimeIdentity } = require('../../src/runtime-identity')

// #167 box 5: `page status` surfaces runtime identity per agent (the resolved page path and
// the commit behind it), so the fleet can see WHAT is running, not just that it is running.
describe('#167 RuntimeIdentity resolver', () => {
  it('resolves the invoked binary to its real path and the checkout commit', () => {
    const identity = RuntimeIdentity({
      argv1: '/link/bin/page',
      realpath: () => '/checkout/bin/page',
      gitHead: (dir) => {
        assert.equal(dir, '/checkout/bin')
        return '400977d0f'
      },
    })()
    assert.deepEqual(identity, {
      path: '/checkout/bin/page',
      commit: '400977d0f',
    })
  })

  it('answers "not a git checkout" when git cannot resolve a HEAD', () => {
    const identity = RuntimeIdentity({
      argv1: '/x/page',
      realpath: (p) => p,
      gitHead: () => {
        throw new Error('not a git repository')
      },
    })()
    assert.equal(identity.commit, 'not a git checkout')
  })
})

describe('#167 page status renders runtime identity', () => {
  const runStatus = async (sessions) => {
    const output = []
    const cli = Cli({
      configLoader: { agentsRoot: '/mock/agents' },
      sessionTracker: { listSessions: () => sessions },
      runtimeIdentity: () => ({
        path: '/checkout/bin/page',
        commit: '400977d0f',
      }),
      stdout: (msg) => output.push(msg),
      stderr: (msg) => output.push(`ERR: ${msg}`),
    })
    const code = await cli.run(['status'])
    return { code, text: output.join('\n') }
  }

  it('prints a RUNTIME column per session and the invoking runtime line', async () => {
    const { code, text } = await runStatus([
      {
        agent: 'bravo',
        project: 'pp',
        pid: 4242,
        status: 'running',
        startedAt: Date.now() - 60000,
        runtime: { path: '/checkout/bin/page', commit: '400977d0f' },
      },
    ])
    assert.equal(code, 0)
    assert.match(text, /RUNTIME/)
    assert.match(text, /bravo\s+pp\s+4242\s+running\s+\S+\s+400977d0f/)
    assert.match(text, /runtime: \/checkout\/bin\/page @ 400977d0f/)
  })

  it('renders "-" for a session that predates runtime recording', async () => {
    const { text } = await runStatus([
      {
        agent: 'alpha',
        project: 'pi',
        pid: 1,
        status: 'running',
        startedAt: Date.now(),
      },
    ])
    assert.match(text, /alpha\s+pi\s+1\s+running\s+\S+\s+-/)
  })
})
