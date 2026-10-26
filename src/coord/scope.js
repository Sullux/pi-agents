const { ownerOf, cleanAgent } = require('./owner')

// #816: the heading must start a LINE, and fenced code blocks are skipped. This used to be
// `body.match(/## Files\s*([\s\S]*?)(?:\n##|$)/)` - unanchored, so the first occurrence of that
// character sequence anywhere in the body won. An issue documenting the Files section parsed its
// own prose as scope and dropped its real paths (measured: 2 prose fragments, 0 paths), and a
// fenced ```md example contributed the example path plus its closing fence.
const FENCE = /^(```|~~~)/

const parseScope = (body = '') => {
  const entries = []
  let inFence = false
  let inFiles = false

  for (const line of body.split('\n')) {
    const entry = line.trim()

    if (FENCE.test(entry)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    if (/^## Files/.test(line)) {
      inFiles = true
      continue
    }
    // Any other H2 closes the section, exactly as the old `\n##` terminator did. An H3
    // subsection stays content - it is dropped by the `#` filter below, unchanged.
    if (/^## /.test(line)) {
      inFiles = false
      continue
    }

    if (inFiles && entry && !entry.startsWith('_(') && !entry.startsWith('#')) {
      entries.push(entry)
    }
  }

  return entries
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
