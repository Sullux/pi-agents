const { checkBacklogAvailability } = require('./preflight')
const { waitInterruptible } = require('./countdown')
const { runPiSession } = require('./session')

const Runner = ({
  github,
  agent,
  targetPath,
  model,
  thinking,
  env = {},
  waitImpl = waitInterruptible,
  sessionImpl = runPiSession,
} = {}) => {
  const runLoop = async ({ maxCycles = Infinity, onCycle } = {}) => {
    let cycle = 1

    while (cycle <= maxCycles) {
      if (onCycle) onCycle(cycle)

      // 1. Preflight check
      const availability = await checkBacklogAvailability({ github, agent })

      if (availability.status === 'idle_empty') {
        const cancelled = await waitImpl(availability.waitSeconds, '[Backlog Empty] No open issues in repository.')
        if (cancelled) return { stopped: true, reason: 'user_exit', cycle }
        continue
      }

      if (availability.status === 'idle_busy') {
        const cancelled = await waitImpl(
          availability.waitSeconds,
          '[Contention] All open issues claimed; waiting on peer PRs.',
        )
        if (cancelled) return { stopped: true, reason: 'user_exit', cycle }
        continue
      }

      // 2. Work available -> Run Pi session
      await sessionImpl({
        targetPath,
        model,
        thinking,
        env,
      })

      cycle += 1

      // 10s cooldown between sessions
      const cancelledCooldown = await waitImpl(10, '[Session Complete] Waiting 10s cooldown before next cycle.')
      if (cancelledCooldown) return { stopped: true, reason: 'user_exit', cycle }
    }

    return { stopped: true, reason: 'max_cycles_reached', cycle }
  }

  return {
    runLoop,
  }
}

module.exports = {
  Runner,
}
