const path = require('node:path')

const DEFAULT_SYSTEM_CONFIG = (homeDir) => ({
  agentsRoot: path.join(homeDir, 'agents'),
  defaultModel: 'anthropic:claude-3-5-sonnet-latest',
  defaultThinking: 'low',
  defaultEnv: {},
})

const SystemConfig = ({ fs, homeDir }) => {
  const configPath = path.join(homeDir, '.config', 'page', 'config.json')

  const load = () => {
    const defaults = DEFAULT_SYSTEM_CONFIG(homeDir)
    if (!fs.existsSync(configPath)) {
      return defaults
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      return { ...defaults, ...parsed }
    } catch {
      return defaults
    }
  }

  const save = (config) => {
    const dir = path.dirname(configPath)
    if (fs.mkdirSync) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
  }

  return {
    configPath,
    load,
    save,
  }
}

module.exports = {
  SystemConfig,
}
