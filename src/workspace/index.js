const path = require('node:path')
const { execFileSync } = require('node:child_process')

const WorkspaceManager = ({ fs, agentsRoot, exec = execFileSync } = {}) => {
  const getAgentDir = (agent) => path.join(agentsRoot, agent)
  const getWorkspacePath = (agent, projectAlias) =>
    path.join(getAgentDir(agent), projectAlias)
  const getProjectsDir = (agent) => path.join(getAgentDir(agent), 'projects')

  const exists = (agent, projectAlias) =>
    fs.existsSync(getWorkspacePath(agent, projectAlias))

  const provisionInstanceFiles = (
    agent,
    projectAlias,
    { defaultPort } = {},
  ) => {
    const projDir = getProjectsDir(agent)
    if (!fs.existsSync(projDir) && fs.mkdirSync) {
      fs.mkdirSync(projDir, { recursive: true })
    }

    const envPath = path.join(projDir, `${projectAlias}.env`)
    if (!fs.existsSync(envPath)) {
      const content = defaultPort
        ? `PORT=${defaultPort}\n`
        : '# Custom environment overrides\n'
      fs.writeFileSync(envPath, content)
    }

    const mdPath = path.join(projDir, `${projectAlias}.md`)
    if (!fs.existsSync(mdPath)) {
      fs.writeFileSync(mdPath, `# Guidance for ${agent} on ${projectAlias}\n\n`)
    }
  }

  const clone = (agent, projectAlias, repoUrl) => {
    const wsPath = getWorkspacePath(agent, projectAlias)
    const agentDir = getAgentDir(agent)
    if (!fs.existsSync(agentDir) && fs.mkdirSync) {
      fs.mkdirSync(agentDir, { recursive: true })
    }
    exec('git', ['clone', repoUrl, wsPath], { stdio: 'inherit' })
    provisionInstanceFiles(agent, projectAlias)
    return wsPath
  }

  return {
    getAgentDir,
    getWorkspacePath,
    getProjectsDir,
    exists,
    provisionInstanceFiles,
    clone,
  }
}

module.exports = {
  WorkspaceManager,
}
