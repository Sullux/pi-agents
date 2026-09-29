const parseEnv = (content = '') =>
  content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .reduce((acc, line) => {
      const equalsIdx = line.indexOf('=')
      if (equalsIdx === -1) return acc
      const key = line.slice(0, equalsIdx).trim()
      let val = line.slice(equalsIdx + 1).trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      return { ...acc, [key]: val }
    }, {})

const formatEnv = (envObj = {}) =>
  Object.entries(envObj)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n') + '\n'

module.exports = {
  parseEnv,
  formatEnv,
}
