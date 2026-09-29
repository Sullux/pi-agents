const path = require('node:path')
const os = require('node:os')

const ProfileManager = ({
  fs = require('node:fs'),
  homeDir = os.homedir(),
} = {}) => {
  const configDir = path.join(homeDir, '.config', 'page')
  const profilesPath = path.join(configDir, 'profiles.json')
  const configPath = path.join(configDir, 'config.json')

  const loadConfig = () => {
    if (!fs.existsSync(configPath)) return {}
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'))
    } catch {
      return {}
    }
  }

  const saveConfig = (cfg) => {
    if (fs.mkdirSync) fs.mkdirSync(configDir, { recursive: true })
    if (fs.writeFileSync)
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2))
  }

  const loadProfiles = () => {
    if (!fs.existsSync || !fs.existsSync(profilesPath)) return {}
    try {
      return JSON.parse(fs.readFileSync(profilesPath, 'utf8'))
    } catch {
      return {}
    }
  }

  const saveProfiles = (data) => {
    if (fs.mkdirSync) fs.mkdirSync(configDir, { recursive: true })
    if (fs.writeFileSync)
      fs.writeFileSync(profilesPath, JSON.stringify(data, null, 2))
  }

  const resolveActiveProfileName = (flags = {}, env = process.env) => {
    if (flags.profile || flags.p) return flags.profile || flags.p
    if (env.PAGE_PROFILE) return env.PAGE_PROFILE
    const cfg = loadConfig()
    if (cfg.activeProfile) return cfg.activeProfile
    return 'default'
  }

  const listProfiles = () => {
    const profiles = loadProfiles()
    return Object.entries(profiles).map(([name, data]) => ({
      name,
      ...data,
    }))
  }

  const getProfile = (name) => {
    const profiles = loadProfiles()
    return profiles[name] ? { name, ...profiles[name] } : undefined
  }

  const addProfile = (name, targetPath, options = {}) => {
    const resolvedPath = path.resolve(targetPath.replace(/^~/, homeDir))
    const pageDir = path.join(resolvedPath, '.page')
    const agentsDir = path.join(resolvedPath, '.agents', 'skills')

    if (fs.mkdirSync) {
      fs.mkdirSync(pageDir, { recursive: true })
      fs.mkdirSync(agentsDir, { recursive: true })
    }

    const profileJsonPath = path.join(pageDir, 'profile.json')
    if (fs.existsSync && !fs.existsSync(profileJsonPath) && fs.writeFileSync) {
      const defaultProfileData = {
        name,
        defaultModel:
          options.defaultModel || 'anthropic:claude-3-5-sonnet-latest',
        defaultThinking: options.defaultThinking || 'low',
      }
      fs.writeFileSync(
        profileJsonPath,
        JSON.stringify(defaultProfileData, null, 2),
      )
    }

    const profileEnvPath = path.join(pageDir, 'profile.env')
    if (fs.existsSync && !fs.existsSync(profileEnvPath) && fs.writeFileSync) {
      fs.writeFileSync(
        profileEnvPath,
        '# Profile-level secrets and environment overrides\n',
      )
    }

    const profiles = loadProfiles()
    profiles[name] = {
      path: resolvedPath,
      createdAt: Date.now(),
    }
    saveProfiles(profiles)

    const cfg = loadConfig()
    if (!cfg.activeProfile || options.use) {
      cfg.activeProfile = name
      saveConfig(cfg)
    }

    return { name, path: resolvedPath, ...profiles[name] }
  }

  const removeProfile = (name) => {
    const profiles = loadProfiles()
    if (!profiles[name]) return false
    delete profiles[name]
    saveProfiles(profiles)
    return true
  }

  const useProfile = (name) => {
    const cfg = loadConfig()
    cfg.activeProfile = name
    saveConfig(cfg)
    return name
  }

  return {
    listProfiles,
    getProfile,
    addProfile,
    removeProfile,
    resolveActiveProfileName,
    useProfile,
  }
}

module.exports = {
  ProfileManager,
}
