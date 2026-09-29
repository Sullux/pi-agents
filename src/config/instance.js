const path = require('node:path')
const { parseEnv, formatEnv } = require('./env')

const InstanceConfig = ({ fs, agentsRoot }) => {
  const getProjectsDir = (agentName) => path.join(agentsRoot, agentName, 'projects')
  const getEnvPath = (agentName, projectAlias) => path.join(getProjectsDir(agentName), `${projectAlias}.env`)
  const getGuidancePath = (agentName, projectAlias) => path.join(getProjectsDir(agentName), `${projectAlias}.md`)

  const loadEnv = (agentName, projectAlias) => {
    const file = getEnvPath(agentName, projectAlias)
    if (!fs.existsSync(file)) return {}
    return parseEnv(fs.readFileSync(file, 'utf8'))
  }

  const saveEnv = (agentName, projectAlias, envObj) => {
    const file = getEnvPath(agentName, projectAlias)
    if (fs.mkdirSync) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
    }
    fs.writeFileSync(file, formatEnv(envObj))
  }

  const loadGuidance = (agentName, projectAlias) => {
    const file = getGuidancePath(agentName, projectAlias)
    if (!fs.existsSync(file)) return ''
    return fs.readFileSync(file, 'utf8')
  }

  const saveGuidance = (agentName, projectAlias, text) => {
    const file = getGuidancePath(agentName, projectAlias)
    if (fs.mkdirSync) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
    }
    fs.writeFileSync(file, text)
  }

  return {
    getEnvPath,
    getGuidancePath,
    loadEnv,
    saveEnv,
    loadGuidance,
    saveGuidance,
  }
}

module.exports = {
  InstanceConfig,
}
