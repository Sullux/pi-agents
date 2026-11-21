const NO_PROGRESS_RESET_THRESHOLD = 2
const NO_PROGRESS_BACKOFF_SECONDS = [60, 120, 240, 300]
const DEFAULT_COOLDOWN_SECONDS = 10

const nextProgressState = (streak = 0, sessionResult = {}) => {
  if (sessionResult?.hadToolUse !== false) {
    return {
      streak: 0,
      forceFreshSession: false,
      waitSeconds: DEFAULT_COOLDOWN_SECONDS,
      waitMessage: '[Session Complete] Waiting 10s cooldown before next cycle.',
    }
  }

  const nextStreak = streak + 1
  const forceFreshSession = nextStreak >= NO_PROGRESS_RESET_THRESHOLD
  const backoffIndex = nextStreak - NO_PROGRESS_RESET_THRESHOLD - 1
  const waitSeconds =
    backoffIndex >= 0
      ? NO_PROGRESS_BACKOFF_SECONDS[
          Math.min(backoffIndex, NO_PROGRESS_BACKOFF_SECONDS.length - 1)
        ]
      : DEFAULT_COOLDOWN_SECONDS
  const waitMessage =
    backoffIndex >= 0
      ? `[No Progress] Zero tool activity for ${nextStreak} cycles; backing off ${waitSeconds}s.`
      : '[Session Complete] Waiting 10s cooldown before next cycle.'

  return {
    streak: nextStreak,
    forceFreshSession,
    waitSeconds,
    waitMessage,
  }
}

module.exports = {
  NO_PROGRESS_RESET_THRESHOLD,
  NO_PROGRESS_BACKOFF_SECONDS,
  DEFAULT_COOLDOWN_SECONDS,
  nextProgressState,
}
