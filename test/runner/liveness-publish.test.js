const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { SessionTracker } = require('../../src/runner/sessionTracker')
const { Runner } = require('../../src/runner')
const { WAVE_STATES } = require('../../src/runner/liveness')

// #166 box 3 (writer side): the runner publishes wave states drawn from the shared vocabulary, and the
// streak counts consecutive byte-identical advisories. The reader derives wedged; the writer never does.
const memFs = () => {
  const files = new Map()
  return {
    files,
    mkdirSync: () => {},
    writeFileSync: (f, data) => files.set(f, data),
    readFileSync: (f) => files.get(f),
    existsSync: (f) => files.has(f),
    unlinkSync: (f) => files.delete(f),
    readdirSync: () => [],
  }
}

describe('#166 publishLiveness streak (the duplicate, not a clock)', () => {
  const trackerWith = () => {
    const fsImpl = memFs()
    const tracker = SessionTracker({
      fs: fsImpl,
      agentsRoot: '/agents',
      now: () => 1,
    })
    tracker.startSession('bravo', 'pp', 42)
    return { tracker, fsImpl }
  }
  const read = (fsImpl) =>
    JSON.parse(fsImpl.files.get('/agents/bravo/.session.json'))

  test('first advisory sets streak 1; identical repeats increment; different resets', () => {
    const { tracker, fsImpl } = trackerWith()
    tracker.publishLiveness('bravo', {
      waveState: 'idle',
      advisory: 'same note',
    })
    assert.equal(read(fsImpl).advisoryStreak, 1)
    tracker.publishLiveness('bravo', {
      waveState: 'idle',
      advisory: 'same note',
    })
    assert.equal(read(fsImpl).advisoryStreak, 2)
    tracker.publishLiveness('bravo', {
      waveState: 'idle',
      advisory: 'same note',
    })
    assert.equal(read(fsImpl).advisoryStreak, 3)
    tracker.publishLiveness('bravo', {
      waveState: 'idle',
      advisory: 'a different note',
    })
    assert.equal(read(fsImpl).advisoryStreak, 1)
  })

  test('an empty advisory resets the streak to 0 (silence is not a repeat)', () => {
    const { tracker, fsImpl } = trackerWith()
    tracker.publishLiveness('bravo', { waveState: 'idle', advisory: 'note' })
    tracker.publishLiveness('bravo', { waveState: 'idle', advisory: 'note' })
    tracker.publishLiveness('bravo', { waveState: 'idle', advisory: '' })
    assert.equal(read(fsImpl).advisoryStreak, 0)
  })

  test('the published wave state is recorded verbatim', () => {
    const { tracker, fsImpl } = trackerWith()
    tracker.publishLiveness('bravo', { waveState: 'in-wave', advisory: 'x' })
    assert.equal(read(fsImpl).waveState, 'in-wave')
  })
})

describe('#166 the runner publishes wave states from the shared vocabulary', () => {
  const fakeTracker = (calls) => ({
    startSession: () => {},
    updateStatus: () => {},
    endSession: () => {},
    publishLiveness: (agent, payload) => calls.push(payload),
  })
  const githubWithWork = {
    listIssues: async () => [
      {
        number: 1,
        labels: [{ name: 'status:unclaimed' }, { name: 'type:task' }],
        comments: [],
      },
    ],
    listPrs: async () => [],
  }

  test('a work cycle publishes in-wave, a member of WAVE_STATES', async () => {
    const calls = []
    const runner = Runner({
      github: githubWithWork,
      agent: 'bravo',
      project: 'pp',
      targetPath: '/tmp/x',
      sessionTracker: fakeTracker(calls),
      waitImpl: async () => false,
      sessionImpl: async () => ({ code: 0 }),
    })
    await runner.runLoop({ maxCycles: 1 })
    assert.ok(calls.length >= 1, 'the runner published liveness')
    assert.ok(calls.every((c) => WAVE_STATES.includes(c.waveState)))
    assert.ok(calls.some((c) => c.waveState === 'in-wave'))
  })

  test('an empty-backlog cycle publishes idle, a member of WAVE_STATES', async () => {
    const calls = []
    const runner = Runner({
      github: { listIssues: async () => [], listPrs: async () => [] },
      agent: 'bravo',
      project: 'pp',
      targetPath: '/tmp/x',
      sessionTracker: fakeTracker(calls),
      waitImpl: async () => true,
      sessionImpl: async () => ({ code: 0 }),
    })
    await runner.runLoop({ maxCycles: 1 })
    assert.ok(calls.length >= 1)
    assert.ok(calls.every((c) => WAVE_STATES.includes(c.waveState)))
    assert.ok(calls.some((c) => c.waveState === 'idle'))
  })
})
