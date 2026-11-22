const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { SessionTracker } = require('../../src/runner/sessionTracker')

// #167 box 5: a session records the runtime that started it, so the board can name what each
// agent is running. Injected identity keeps the pin deterministic (no real git spawn).
describe('#167 session records runtime identity', () => {
  const mockFs = () => {
    const files = {}
    return {
      files,
      existsSync: (p) => Boolean(files[p]),
      readFileSync: (p) => files[p] || '',
      writeFileSync: (p, data) => {
        files[p] = data
      },
      unlinkSync: (p) => {
        delete files[p]
      },
      mkdirSync: () => {},
      readdirSync: () => [],
    }
  }

  it('startSession writes the injected runtime path and commit', () => {
    const fs = mockFs()
    const tracker = SessionTracker({
      fs,
      agentsRoot: '/mock/agents',
      isAlive: () => true,
      now: () => 1000,
      runtimeIdentity: () => ({
        path: '/checkout/bin/page',
        commit: '400977d0f',
      }),
    })
    tracker.startSession('bravo', 'pp', 4242)
    const session = JSON.parse(fs.files['/mock/agents/bravo/.session.json'])
    assert.deepEqual(session.runtime, {
      path: '/checkout/bin/page',
      commit: '400977d0f',
    })
    assert.equal(session.agent, 'bravo')
    assert.equal(session.startedAt, 1000)
  })
})
