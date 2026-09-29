const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { SessionTracker } = require('../../src/runner/sessionTracker')

describe('SessionTracker', () => {
  it('creates, reads, and cleans up session file', () => {
    let files = {}
    const mockFs = {
      existsSync: (p) => p === '/mock/agents' || Boolean(files[p]),
      readFileSync: (p) => files[p] || '',
      writeFileSync: (p, data) => {
        files[p] = data
      },
      unlinkSync: (p) => {
        delete files[p]
      },
      mkdirSync: () => {},
      readdirSync: () => ['alpha', 'bravo'],
    }

    const tracker = SessionTracker({
      fs: mockFs,
      agentsRoot: '/mock/agents',
      isAlive: () => true,
    })

    // 1. Start session
    tracker.startSession('alpha', 'pp', 12345)
    assert.ok(files['/mock/agents/alpha/.session.json'])

    // 2. Read session
    const sessions = tracker.listSessions()
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].agent, 'alpha')
    assert.equal(sessions[0].project, 'pp')
    assert.equal(sessions[0].pid, 12345)

    // 3. Filter by project
    assert.equal(tracker.listSessions('other').length, 0)
    assert.equal(tracker.listSessions('pp').length, 1)

    // 4. End session
    tracker.endSession('alpha')
    assert.equal(files['/mock/agents/alpha/.session.json'], undefined)
  })

  it('prunes dead process session files automatically', () => {
    let files = {
      '/mock/agents/bravo/.session.json': JSON.stringify({
        pid: 99999,
        agent: 'bravo',
        project: 'pp',
        startedAt: 1000,
        status: 'running',
      }),
    }

    const mockFs = {
      existsSync: (p) => p === '/mock/agents' || Boolean(files[p]),
      readFileSync: (p) => files[p] || '',
      writeFileSync: (p, data) => {
        files[p] = data
      },
      unlinkSync: (p) => {
        delete files[p]
      },
      readdirSync: () => ['bravo'],
    }

    const tracker = SessionTracker({
      fs: mockFs,
      agentsRoot: '/mock/agents',
      isAlive: (pid) => pid !== 99999, // 99999 is dead
    })

    const sessions = tracker.listSessions()
    assert.equal(sessions.length, 0)
    assert.equal(files['/mock/agents/bravo/.session.json'], undefined) // pruned
  })

  it('stops an active agent session via signal', () => {
    let files = {
      '/mock/agents/alpha/.session.json': JSON.stringify({
        pid: 4321,
        agent: 'alpha',
        project: 'pp',
        startedAt: 1000,
        status: 'running',
      }),
    }
    let killed = []

    const mockFs = {
      existsSync: (p) => Boolean(files[p]),
      readFileSync: (p) => files[p] || '',
      unlinkSync: (p) => {
        delete files[p]
      },
      readdirSync: () => ['alpha'],
    }

    const tracker = SessionTracker({
      fs: mockFs,
      agentsRoot: '/mock/agents',
      isAlive: () => true,
      killProcess: (pid, sig) => killed.push({ pid, sig }),
    })

    const res = tracker.stopSession('alpha')
    assert.equal(res.ok, true)
    assert.equal(killed[0].pid, 4321)
    assert.equal(killed[0].sig, 'SIGTERM')
  })
})
