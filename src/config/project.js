const path = require('node:path')

const ProjectConfig = ({ fs, homeDir }) => {
  const projectsDir = path.join(homeDir, '.config', 'page', 'projects')

  const getProjectPath = (alias) => path.join(projectsDir, `${alias}.json`)

  const load = (alias) => {
    const file = getProjectPath(alias)
    if (!fs.existsSync(file)) return undefined
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return undefined
    }
  }

  const list = () => {
    if (!fs.existsSync(projectsDir)) return []
    return fs
      .readdirSync(projectsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5))
  }

  const save = (alias, projectData) => {
    if (fs.mkdirSync) {
      fs.mkdirSync(projectsDir, { recursive: true })
    }
    fs.writeFileSync(
      getProjectPath(alias),
      JSON.stringify(projectData, null, 2),
    )
  }

  return {
    load,
    list,
    save,
  }
}

module.exports = {
  ProjectConfig,
}
