const { checkBacklogAvailability } = require('./preflight')
const { waitInterruptible } = require('./countdown')
const { runPiSession } = require('./session')
const { SessionTracker } = require('./sessionTracker')

// #90: join the per-PR advice that `preflight` computed - do NOT re-derive causes here, or this renderer
// drifts from the classifier exactly the way #87's writer and #87's matcher did. Cap the list so a
// 20-PR board cannot bury the prompt, and say how many were dropped rather than truncating silently.
const MAX_GAP_LINES = 4

const describeReviewGaps = (gaps = []) => {
  const owed = gaps.filter((g) => g.gap !== 'reviewed')
  if (owed.length === 0) return ''
  const shown = owed
    .slice(0, MAX_GAP_LINES)
    .map((g) => `#${g.number}: ${g.hint}`)
    .join('; ')
  const rest = owed.length - Math.min(owed.length, MAX_GAP_LINES)
  const suffix = rest > 0 ? ` (+${rest} more)` : ''
  return `Review owed on ${owed.length} open PR${owed.length === 1 ? '' : 's'} - ${shown}${suffix}`
}

const resolveCyclePrompt = ({
  isNewTask = false,
  steering = '',
  reviewGaps = [],
} = {}) => {
  const base = isNewTask
    ? 'Proceed with development using the coordinate skill (finish any in-progress work, or check the board and PRs if ready for a new task).'
    : 'Continue development using the coordinate skill.'
  const hint = describeReviewGaps(reviewGaps)
  const withHint = hint ? `${base}\n${hint}` : base
  return steering
    ? `${withHint} Explicit steering from user: ${steering}`
    : withHint
}

const Runner = ({
  github,
  agent,
  project,
  targetPath,
  steering = '',
  model,
  thinking,
  env = {},
  sessionTracker,
  waitImpl = waitInterruptible,
  sessionImpl = runPiSession,
} = {}) => {
  const runLoop = async ({ maxCycles = Infinity, onCycle } = {}) => {
    if (sessionTracker && project) {
      sessionTracker.startSession(agent, project)
    }

    let cycle = 1
    let previousReason = null

    try {
      while (cycle <= maxCycles) {
        if (onCycle) onCycle(cycle)

        // 1. Preflight check
        const availability = await checkBacklogAvailability({ github, agent })

        if (availability.status === 'idle_empty') {
          if (sessionTracker)
            sessionTracker.updateStatus(agent, 'waiting (empty)')
          const cancelled = await waitImpl(
            availability.waitSeconds,
            '[Backlog Empty] No open issues in repository.',
          )
          if (cancelled) return { stopped: true, reason: 'user_exit', cycle }
          continue
        }

        if (availability.status === 'idle_busy') {
          if (sessionTracker)
            sessionTracker.updateStatus(agent, 'waiting (busy)')
          const cancelled = await waitImpl(
            availability.waitSeconds,
            '[Contention] All open issues claimed; waiting on peer PRs.',
          )
          if (cancelled) return { stopped: true, reason: 'user_exit', cycle }
          continue
        }

        // 2. Work available -> Run Pi session
        const isNewTask =
          previousReason === 'owned_claims' &&
          availability.reason === 'unclaimed_tasks'
        previousReason = availability.reason

        if (sessionTracker) sessionTracker.updateStatus(agent, 'running')
        await sessionImpl({
          targetPath,
          prompt: resolveCyclePrompt({
            isNewTask,
            steering,
            reviewGaps: availability.reviewGaps || [],
          }),
          continueSession: !isNewTask,
          model,
          thinking,
          env,
        })

        cycle += 1

        // 10s cooldown between sessions
        if (sessionTracker) sessionTracker.updateStatus(agent, 'cooldown')
        const cancelledCooldown = await waitImpl(
          10,
          '[Session Complete] Waiting 10s cooldown before next cycle.',
        )
        if (cancelledCooldown)
          return { stopped: true, reason: 'user_exit', cycle }
      }

      return { stopped: true, reason: 'max_cycles_reached', cycle }
    } finally {
      if (sessionTracker) sessionTracker.endSession(agent)
    }
  }

  return {
    runLoop,
  }
}

module.exports = {
  Runner,
  SessionTracker,
  resolveCyclePrompt,
  describeReviewGaps,
}
