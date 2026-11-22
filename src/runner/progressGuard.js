const NO_PROGRESS_RESET_THRESHOLD = 2
const NO_PROGRESS_BACKOFF_SECONDS = [60, 120, 240, 300]
const DEFAULT_COOLDOWN_SECONDS = 10

const normalizePrev = (prev) =>
  typeof prev === 'number'
    ? { streak: prev, idleStreak: 0, lastAssistantText: '' }
    : {
        streak: prev?.streak || 0,
        idleStreak: prev?.idleStreak || 0,
        lastAssistantText: prev?.lastAssistantText || '',
      }

const idleBackoffSeconds = (index) =>
  NO_PROGRESS_BACKOFF_SECONDS[
    Math.min(index, NO_PROGRESS_BACKOFF_SECONDS.length - 1)
  ]

const nextProgressState = (prev = 0, sessionResult = {}) => {
  const { streak, idleStreak, lastAssistantText } = normalizePrev(prev)

  if (sessionResult?.hadToolUse === false) {
    const nextStreak = streak + 1
    const forceFreshSession = nextStreak >= NO_PROGRESS_RESET_THRESHOLD
    const backoffIndex = nextStreak - NO_PROGRESS_RESET_THRESHOLD - 1
    const waitSeconds =
      backoffIndex >= 0
        ? idleBackoffSeconds(backoffIndex)
        : DEFAULT_COOLDOWN_SECONDS
    const waitMessage =
      backoffIndex >= 0
        ? `[No Progress] Zero tool activity for ${nextStreak} cycles; backing off ${waitSeconds}s.`
        : '[Session Complete] Waiting 10s cooldown before next cycle.'

    return {
      streak: nextStreak,
      idleStreak: 0,
      lastAssistantText: '',
      forceFreshSession,
      waitSeconds,
      waitMessage,
    }
  }

  const text = String(sessionResult?.assistantText || '').trim()
  const repeatedNoEdit =
    !sessionResult?.hadEdit &&
    Boolean(text) &&
    Boolean(lastAssistantText) &&
    text === lastAssistantText
  const isIdleSpin = sessionResult?.isIdleExit === true || repeatedNoEdit

  if (isIdleSpin) {
    const nextIdleStreak = idleStreak + 1
    const forceFreshSession = nextIdleStreak >= NO_PROGRESS_RESET_THRESHOLD
    const waitSeconds = idleBackoffSeconds(nextIdleStreak - 1)

    return {
      streak: 0,
      idleStreak: nextIdleStreak,
      lastAssistantText: text,
      forceFreshSession,
      waitSeconds,
      waitMessage: `[Idle Spin] No actionable progress (${nextIdleStreak} cycle(s)); backing off ${waitSeconds}s.`,
    }
  }

  return {
    streak: 0,
    idleStreak: 0,
    lastAssistantText: sessionResult?.hadEdit ? '' : text,
    forceFreshSession: false,
    waitSeconds: DEFAULT_COOLDOWN_SECONDS,
    waitMessage: '[Session Complete] Waiting 10s cooldown before next cycle.',
  }
}

module.exports = {
  NO_PROGRESS_RESET_THRESHOLD,
  NO_PROGRESS_BACKOFF_SECONDS,
  DEFAULT_COOLDOWN_SECONDS,
  nextProgressState,
}
