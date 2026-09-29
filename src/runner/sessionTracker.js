const path = require('node:path')
const fs = require('node:fs')

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
    endSession,
    listSessions,
    stopSession,
  }
}

module.exports = {
  SessionTracker,
}
