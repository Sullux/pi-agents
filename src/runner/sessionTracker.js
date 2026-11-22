const path = require('node:path')
const fs = require('node:fs')
const { RuntimeIdentity } = require('../runtime-identity')

const defaultIsAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const defaultKill = (pid, sig = 'SIGTERM') => process.kill(pid, sig)

const SessionTracker = ({
  fs: fsImpl = fs,
  agentsRoot,
  isAlive = defaultIsAlive,
  killProcess = defaultKill,
  now = Date.now,
  // #167 box 5: record the runtime that started the session, so `page status` can name what
  // each agent is running, not just that it is running. Injected like the other reads.
  runtimeIdentity = RuntimeIdentity(),
} = {}) => {
  const getSessionFile = (agent) =>
    path.join(agentsRoot, agent, '.session.json')

  const startSession = (agent, project, pid = process.pid) => {
    const file = getSessionFile(agent)
    const dir = path.dirname(file)
    if (fsImpl.mkdirSync) fsImpl.mkdirSync(dir, { recursive: true })

    const sessionData = {
      pid,
      agent,
      project,
      startedAt: now(),
      status: 'running',
      runtime: runtimeIdentity(),
    }
    fsImpl.writeFileSync(file, JSON.stringify(sessionData, null, 2))

    const cleanup = () => {
      try {
        if (fsImpl.existsSync(file)) fsImpl.unlinkSync(file)
      } catch {}
    }

    if (process.on) {
      process.once('exit', cleanup)
      process.once('SIGINT', () => {
        cleanup()
        process.exit(0)
      })
      process.once('SIGTERM', () => {
        cleanup()
        process.exit(0)
      })
    }
  }

  const updateStatus = (agent, status) => {
    const file = getSessionFile(agent)
    if (!fsImpl.existsSync(file)) return
    try {
      const data = JSON.parse(fsImpl.readFileSync(file, 'utf8'))
      data.status = status
      data.updatedAt = now()
      fsImpl.writeFileSync(file, JSON.stringify(data, null, 2))
    } catch {}
  }

  // #166: the runner publishes its wave state and the cycle's advisory text; the streak counts
  // consecutive byte-identical advisories (the wedged signal box 2 conjoins with behind). An empty
  // advisory resets the streak to 0 - silence is not a repeated advisory. The reader derives `wedged`
  // from this streak plus the boot's depth-behind; the runner never self-reports wedged.
  const publishLiveness = (agent, { waveState, advisory = '' }) => {
    const file = getSessionFile(agent)
    if (!fsImpl.existsSync(file)) return
    try {
      const data = JSON.parse(fsImpl.readFileSync(file, 'utf8'))
      data.advisoryStreak = advisory
        ? advisory === data.lastAdvisory
          ? (data.advisoryStreak || 1) + 1
          : 1
        : 0
      data.waveState = waveState
      data.lastAdvisory = advisory
      data.updatedAt = now()
      fsImpl.writeFileSync(file, JSON.stringify(data, null, 2))
    } catch {}
  }

  const endSession = (agent) => {
    const file = getSessionFile(agent)
    if (fsImpl.existsSync(file)) {
      try {
        fsImpl.unlinkSync(file)
      } catch {}
    }
  }

  const listSessions = (projectFilter) => {
    if (!fsImpl.existsSync(agentsRoot)) return []
    const agents = fsImpl
      .readdirSync(agentsRoot, { withFileTypes: true })
      .filter((d) => (d.isDirectory ? d.isDirectory() : true))
      .map((d) => (typeof d === 'string' ? d : d.name))
      .filter((name) => !name.startsWith('.'))

    const active = []
    for (const ag of agents) {
      const file = getSessionFile(ag)
      if (fsImpl.existsSync(file)) {
        try {
          const session = JSON.parse(fsImpl.readFileSync(file, 'utf8'))
          if (!isAlive(session.pid)) {
            fsImpl.unlinkSync(file)
          } else if (!projectFilter || session.project === projectFilter) {
            active.push(session)
          }
        } catch {}
      }
    }
    return active
  }

  const stopSession = (agent, { kill = false } = {}) => {
    const file = getSessionFile(agent)
    if (!fsImpl.existsSync(file)) {
      return {
        ok: false,
        error: `No active session found for agent '${agent}'`,
      }
    }
    try {
      const session = JSON.parse(fsImpl.readFileSync(file, 'utf8'))
      if (!isAlive(session.pid)) {
        fsImpl.unlinkSync(file)
        return {
          ok: false,
          error: `Agent '${agent}' session process was already dead (cleaned up)`,
        }
      }
      killProcess(session.pid, kill ? 'SIGKILL' : 'SIGTERM')
      return { ok: true, pid: session.pid }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }

  return {
    startSession,
    updateStatus,
    publishLiveness,
    endSession,
    listSessions,
    stopSession,
  }
}

module.exports = {
  SessionTracker,
}
