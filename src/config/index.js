const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const { SystemConfig } = require('./system')
const { ProjectConfig } = require('./project')
const { AgentConfig } = require('./agent')
const { InstanceConfig } = require('./instance')
const { ProfileManager } = require('./profile')
const { parseEnv } = require('./env')

const ConfigLoader = ({
  fs: fsImpl = fs,
  homeDir = os.homedir(),
  profileName,
  flags = {},
  env = process.env,
} = {}) => {
  const system = SystemConfig({ fs: fsImpl, homeDir })
  const profileMgr = ProfileManager({ fs: fsImpl, homeDir })

  const activeProfileName =
    profileName || profileMgr.resolveActiveProfileName(flags, env)
  let activeProfile = profileMgr.getProfile(activeProfileName)

  if (!activeProfile && activeProfileName === 'default') {
    activeProfile = profileMgr.addProfile(
      'default',
      path.join(homeDir, 'agents'),
    )
  }

  const agentsRoot = activeProfile
    ? activeProfile.path
    : path.join(homeDir, 'agents')

  const project = ProjectConfig({ fs: fsImpl, homeDir })
  const agent = AgentConfig({ fs: fsImpl, agentsRoot })
  const instance = InstanceConfig({ fs: fsImpl, agentsRoot })

  const loadProfileEnv = () => {
    if (!activeProfile) return {}
    const pEnvFile = path.join(activeProfile.path, '.page', 'profile.env')
    if (!fsImpl.existsSync(pEnvFile)) return {}
    return parseEnv(fsImpl.readFileSync(pEnvFile, 'utf8'))
  }

  const resolveInstanceEnv = (agentName, projectAlias) => {
    const sys = system.load()
    const pEnv = loadProfileEnv()
    const proj = project.load(projectAlias) || {}
    const ag = agent.load(agentName) || {}
    const instEnv = instance.loadEnv(agentName, projectAlias)

    return {
      ...(sys.defaultEnv || {}),
      ...pEnv,
      ...(proj.defaultEnv || {}),
      ...(ag.env || {}),
      ...instEnv,
      COORD_AGENT: `agent-${agentName}`,
    }
  }

  return {
    getSystemConfig: system.load,
    saveSystemConfig: system.save,
    profile: profileMgr,
    activeProfile,
    activeProfileName,
    agentsRoot,
    project,
    agent,
    instance,
    resolveInstanceEnv,
  }
}

module.exports = {
  ConfigLoader,
}
