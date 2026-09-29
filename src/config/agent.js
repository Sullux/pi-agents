const path = require('node:path')

const AgentConfig = ({ fs, agentsRoot }) => {
  const getAgentDir = (name) => path.join(agentsRoot, name)
  const getAgentConfigPath = (name) => path.join(getAgentDir(name), 'agent.json')

  const load = (name) => {
    const file = getAgentConfigPath(name)
    if (!fs.existsSync(file)) return undefined
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return undefined
    }
  }

  const list = () => {
    if (!fs.existsSync(agentsRoot)) return []
    return fs
      .readdirSync(agentsRoot, { withFileTypes: true })
      .filter((d) => (d.isDirectory ? d.isDirectory() : true))
      .map((d) => (typeof d === 'string' ? d : d.name))
  }

  const save = (name, agentData) => {
    const file = getAgentConfigPath(name)
    const dir = path.dirname(file)
    if (fs.mkdirSync) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(file, JSON.stringify(agentData, null, 2))
  }

  return {
    getAgentDir,
    load,
    list,
    save,
  }
}

module.exports = {
  AgentConfig,
}
