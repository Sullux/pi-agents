const { ownerOf, cleanAgent } = require('./owner')

const parseScope = (body = '') => {
  const match = body.match(/## Files\s*([\s\S]*?)(?:\n##|$)/)
  if (!match) return []

  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('_(') && !line.startsWith('#'))
}

const checkScopeCollision = (
  targetFiles = [],
  activeIssues = [],
  currentAgent = '',
) => {
  const cleanCurrent = cleanAgent(currentAgent)

  for (const issue of activeIssues) {
    const owner = ownerOf(issue)
    if (!owner || owner === cleanCurrent) continue

    const issueFiles = parseScope(issue.body)
    const collidingFile = targetFiles.find((f) => issueFiles.includes(f))

    if (collidingFile) {
      return {
        hasCollision: true,
        collidingIssue: issue.number,
        collidingAgent: owner,
        collidingFile,
      }
    }
  }

  return { hasCollision: false }
}

module.exports = {
  parseScope,
  checkScopeCollision,
}
