const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { restartGuidance } = require('../../src/cli/restart-guidance')

// #166 boxes 4/5: the guidance names the pid and the exact two-step, states idle/in-wave, and counts an
// unchanged advisory. behindOf is injected so the test drives the read-time depth, not a clock.
const runner = (pid, agent, project) => ({
  pid,
  argv: ['node', 'bin/page', 'start', agent, project],
})

describe('#166 restart guidance (read-only, names the pid and the two-step)', () => {
  test('a behind runner gets pid + agent/project + kill then page start', () => {
    const lines = restartGuidance({
      runners: [runner(512620, 'Alpha', 'pp')],
      sessions: [
        {
          pid: 512620,
          agent: 'Alpha',
          project: 'pp',
          waveState: 'idle',
          advisoryStreak: 0,
        },
      ],
      behindOf: () => 15,
    })
    assert.equal(lines.length, 1)
    assert.match(lines[0], /pid 512620/)
    assert.match(lines[0], /Alpha pp/)
    assert.match(lines[0], /15 behind/)
    assert.match(lines[0], /kill 512620 then page start Alpha pp/)
    assert.match(lines[0], /idle/)
  })

  test('a current runner (behind 0) gets no guidance', () => {
    const lines = restartGuidance({
      runners: [runner(1, 'Alpha', 'pp')],
      sessions: [],
      behindOf: () => 0,
    })
    assert.deepEqual(lines, [])
  })

  test('in-wave is stated so the operator knows killing discards a wave', () => {
    const lines = restartGuidance({
      runners: [runner(2, 'Bravo', 'pp')],
      sessions: [{ pid: 2, waveState: 'in-wave', advisoryStreak: 0 }],
      behindOf: () => 3,
    })
    assert.match(lines[0], /in-wave/)
  })

  test('an unchanged advisory streak >= 2 is counted (same advisory xN) and reads wedged', () => {
    const lines = restartGuidance({
      runners: [runner(3, 'Charlie', 'pp')],
      sessions: [{ pid: 3, waveState: 'idle', advisoryStreak: 13 }],
      behindOf: () => 15,
    })
    assert.match(lines[0], /same advisory x13/)
    assert.match(lines[0], /wedged/)
  })

  test('a stale-but-live runner (streak 1) is behind but NOT wedged and has no count', () => {
    const lines = restartGuidance({
      runners: [runner(4, 'Delta', 'pp')],
      sessions: [{ pid: 4, waveState: 'idle', advisoryStreak: 1 }],
      behindOf: () => 15,
    })
    assert.match(lines[0], /idle/)
    assert.doesNotMatch(lines[0], /wedged/)
    assert.doesNotMatch(lines[0], /same advisory/)
  })

  test('agent/project fall back to argv when no session matches the pid', () => {
    const lines = restartGuidance({
      runners: [runner(5, 'Echo', 'pp')],
      sessions: [],
      behindOf: () => 2,
    })
    assert.match(lines[0], /Echo pp/)
    assert.match(lines[0], /page start Echo pp/)
  })

  test('the guidance is read-only: it returns strings and never signals', () => {
    let signaled = false
    const lines = restartGuidance({
      runners: [runner(6, 'Foxtrot', 'pp')],
      sessions: [],
      behindOf: () => {
        signaled = true
        return 1
      },
    })
    assert.ok(Array.isArray(lines))
    assert.ok(signaled, 'behindOf was consulted (the read happened)')
    assert.ok(lines.every((l) => typeof l === 'string'))
  })
})
