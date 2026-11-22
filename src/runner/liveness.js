// #166: the liveness vocabulary, defined ONCE and consumed by both the writer (the runner loop, which
// publishes its wave state) and the reader (`page status` / `page runners`, which render it). A state
// added to one side only is the failure mode #166 exists to kill - a new state rendering as blank or
// falling through to `running` - so the full set lives here and a pin enumerates it against both sides.
//
// `waveState` is what a runner knows about itself from the prompt loop: between prompts it is idle,
// inside a live child session it is in-wave. `wedged` is NOT self-reported - a stuck runner cannot see
// that it is stuck - it is derived at read time from two signals the issue conjoins: the boot is N
// merges behind the tip AND the last advisory is byte-identical to the one before it (a streak >= 2).
// The duplicate, not a clock, is the discrimination: a stale-but-live runner that is still producing
// DIFFERENT advisories is behind but not wedged.
const IDLE = 'idle'
const IN_WAVE = 'in-wave'
const WEDGED = 'wedged'
const LIVENESS = [IDLE, IN_WAVE, WEDGED]
const WAVE_STATES = [IDLE, IN_WAVE]

const classifyLiveness = ({
  waveState = IDLE,
  behind = 0,
  advisoryStreak = 0,
} = {}) =>
  behind > 0 && advisoryStreak >= 2
    ? WEDGED
    : waveState === IN_WAVE
      ? IN_WAVE
      : IDLE

module.exports = {
  LIVENESS,
  WAVE_STATES,
  IDLE,
  IN_WAVE,
  WEDGED,
  classifyLiveness,
}
