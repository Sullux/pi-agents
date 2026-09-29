const os = require('node:os')
const fs = require('node:fs')
const { SystemConfig } = require('./system')
const { ProjectConfig } = require('./project')
const { AgentConfig } = require('./agent')
const { InstanceConfig } = require('./instance')

const ConfigLoader = ({ fs: fsImpl = fs, homeDir = os.homedir() } = {}) => {
  const system = SystemConfig({ fs: fsImpl, homeDir })
  const systemConfig = system.load()
  const agentsRoot = systemConfig.agentsRoot

  const project = ProjectConfig({ fs: fsImpl, homeDir })
  const agent = AgentConfig({ fs: fsImpl, agentsRoot })
  const instance = InstanceConfig({ fs: fsImpl, agentsRoot })

  const resolveInstanceEnv = (agentName, projectAlias) => {
    const sys = system.load()
    const proj = project.load(projectAlias) || {}
    const ag = agent.load(agentName) || {}
    const instEnv = instance.loadEnv(agentName, projectAlias)

    return {
      ...(sys.defaultEnv || {}),
      ...(proj.defaultEnv || {}),
      ...(ag.env || {}),
      ...instEnv,
      COORD_AGENT: `agent-${agentName}`,
    }
  }

  return {
    getSystemConfig: system.load,
    saveSystemConfig: system.save,
    project,
    agent,
    instance,
    resolveInstanceEnv,
  }
}

module.exports = {
  ConfigLoader,
}
