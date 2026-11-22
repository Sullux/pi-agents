const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const {
  LIVENESS,
  WAVE_STATES,
  classifyLiveness,
} = require('../../src/runner/liveness')

// #166 box 3: the vocabulary is enumerated, not prose. Every member is reachable from the classifier
// and the classifier emits nothing outside the set - a state added to the set but never returned (or
// returned but not in the set) reds here, which is the "added to one side only" failure mode.
describe('#166 liveness vocabulary', () => {
  test('the full set is exactly idle / in-wave / wedged', () => {
    assert.deepEqual([...LIVENESS].sort(), ['idle', 'in-wave', 'wedged'])
  })

  test('every member of the set is reachable from the classifier', () => {
    const reached = new Set([
      classifyLiveness({ waveState: 'idle', behind: 0, advisoryStreak: 0 }),
      classifyLiveness({ waveState: 'in-wave', behind: 0, advisoryStreak: 0 }),
      classifyLiveness({ waveState: 'idle', behind: 3, advisoryStreak: 2 }),
    ])
    assert.deepEqual([...reached].sort(), [...LIVENESS].sort())
  })

  test('the classifier never emits a state outside the set', () => {
    for (const waveState of [...WAVE_STATES, 'unexpected'])
      for (const behind of [0, 1, 15])
        for (const advisoryStreak of [0, 1, 2, 13])
          assert.ok(
            LIVENESS.includes(
              classifyLiveness({ waveState, behind, advisoryStreak }),
            ),
          )
  })

  test('the wave states the runner publishes are a subset of the rendered set', () => {
    for (const w of WAVE_STATES) assert.ok(LIVENESS.includes(w))
  })
})

// #166 box 2: wedged is the CONJUNCTION (behind AND a byte-identical advisory streak), driven by the
// duplicate and not by a timestamp. alpha's stale-but-live counterexample is the behind>0 / streak<2
// arm: behind on its own is not wedged, and a current runner repeating itself is not wedged either.
describe('#166 wedged discrimination (the duplicate, not the clock)', () => {
  test('behind AND two consecutive identical advisories -> wedged', () => {
    assert.equal(
      classifyLiveness({ waveState: 'idle', behind: 15, advisoryStreak: 2 }),
      'wedged',
    )
    assert.equal(
      classifyLiveness({ waveState: 'in-wave', behind: 1, advisoryStreak: 13 }),
      'wedged',
    )
  })

  test('behind but DIFFERENT advisories (streak 1) -> not wedged (stale-but-live)', () => {
    assert.equal(
      classifyLiveness({ waveState: 'idle', behind: 15, advisoryStreak: 1 }),
      'idle',
    )
    assert.equal(
      classifyLiveness({ waveState: 'in-wave', behind: 15, advisoryStreak: 1 }),
      'in-wave',
    )
  })

  test('current (behind 0) repeating an advisory -> not wedged', () => {
    assert.equal(
      classifyLiveness({ waveState: 'idle', behind: 0, advisoryStreak: 13 }),
      'idle',
    )
  })

  test('no advisory yet (streak 0) behind -> not wedged', () => {
    assert.equal(
      classifyLiveness({ waveState: 'idle', behind: 5, advisoryStreak: 0 }),
      'idle',
    )
  })

  test('wave state passes through when not wedged', () => {
    assert.equal(
      classifyLiveness({ waveState: 'in-wave', behind: 0, advisoryStreak: 0 }),
      'in-wave',
    )
    assert.equal(
      classifyLiveness({ waveState: 'idle', behind: 0, advisoryStreak: 0 }),
      'idle',
    )
  })
})
