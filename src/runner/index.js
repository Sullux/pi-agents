const { checkBacklogAvailability } = require('./preflight')
const { waitInterruptible } = require('./countdown')
const { runPiSession } = require('./session')
const { SessionTracker } = require('./sessionTracker')

const resolveCyclePrompt = ({ isNewTask = false, steering = '' } = {}) => {
  const base = isNewTask
    ? 'Proceed with development using the coordinate skill (finish any in-progress work, or check the board and PRs if ready for a new task).'
    : 'Continue development using the coordinate skill.'
  return steering ? `${base} Explicit steering from user: ${steering}` : base
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
          prompt: resolveCyclePrompt({ isNewTask, steering }),
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
}
