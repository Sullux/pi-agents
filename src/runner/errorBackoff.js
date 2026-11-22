const DEFAULT_ERROR_BACKOFF_SECONDS = 300
const RATE_LIMIT_BUFFER_SECONDS = 5
const MAX_RATE_LIMIT_WAIT_SECONDS = 3660
const IDLE_BUSY_BACKOFF_SECONDS = [60, 120, 240, 300]

const isRateLimitError = (error) =>
  /rate limit/i.test(String(error?.message ?? error ?? ''))

const pickResetEpochSeconds = (rateLimitData, errorMessage = '') => {
  const resources = rateLimitData?.resources
  if (!resources) return undefined
  const candidates = /graphql/i.test(errorMessage)
    ? [resources.graphql, resources.search, resources.core]
    : /search/i.test(errorMessage)
      ? [resources.search, resources.graphql, resources.core]
      : [resources.core, resources.graphql, resources.search]
  const exhausted = candidates.find(
    (b) => b && b.remaining === 0 && Number.isFinite(b.reset),
  )
  return exhausted?.reset
}

const formatUtcClock = (epochMs) =>
  `${new Date(epochMs).toISOString().slice(11, 19)}Z`

const resolvePreflightErrorWait = async ({
  error,
  github,
  now = Date.now,
} = {}) => {
  const message = String(error?.message ?? error ?? 'Unknown error').split(
    '\n',
  )[0]
  const rateLimited = isRateLimitError(error)

  if (rateLimited && typeof github?.rateLimit === 'function') {
    try {
      const data = await github.rateLimit()
      const resetSeconds = pickResetEpochSeconds(data, message)
      if (Number.isFinite(resetSeconds)) {
        const resetMs = resetSeconds * 1000
        const deltaSeconds = Math.ceil((resetMs - now()) / 1000)
        if (deltaSeconds > 0) {
          const waitSeconds = Math.min(
            MAX_RATE_LIMIT_WAIT_SECONDS,
            deltaSeconds + RATE_LIMIT_BUFFER_SECONDS,
          )
          return {
            status: 'waiting (rate-limit)',
            waitSeconds,
            resetAt: resetMs,
            waitMessage: `[Rate Limit] ${message} — resets at ${formatUtcClock(resetMs)} (waiting ${waitSeconds}s).`,
          }
        }
      }
    } catch {
      // Fall through to 5-minute default when rate_limit probe fails
    }
  }

  const label = rateLimited ? 'Rate Limit' : 'Preflight Error'
  return {
    status: rateLimited ? 'waiting (rate-limit)' : 'waiting (error)',
    waitSeconds: DEFAULT_ERROR_BACKOFF_SECONDS,
    waitMessage: `[${label}] ${message} — retrying in ${DEFAULT_ERROR_BACKOFF_SECONDS}s.`,
  }
}

const nextIdleBusyWait = (streak = 0) => {
  const idx = Math.min(
    Math.max(0, streak),
    IDLE_BUSY_BACKOFF_SECONDS.length - 1,
  )
  return IDLE_BUSY_BACKOFF_SECONDS[idx]
}

module.exports = {
  DEFAULT_ERROR_BACKOFF_SECONDS,
  RATE_LIMIT_BUFFER_SECONDS,
  MAX_RATE_LIMIT_WAIT_SECONDS,
  IDLE_BUSY_BACKOFF_SECONDS,
  isRateLimitError,
  pickResetEpochSeconds,
  resolvePreflightErrorWait,
  nextIdleBusyWait,
}
