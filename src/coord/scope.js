const { ownerOf, cleanAgent } = require('./owner')

// #816: the heading must start a LINE, and fenced code blocks are skipped. This used to be
// `body.match(/## Files\s*([\s\S]*?)(?:\n##|$)/)` - unanchored, so the first occurrence of that
// character sequence anywhere in the body won. An issue documenting the Files section parsed its
// own prose as scope and dropped its real paths (measured: 2 prose fragments, 0 paths), and a
// fenced ```md example contributed the example path plus its closing fence.
const FENCE = /^(```|~~~)/

// #820: a declared path arrives DECORATED - `- `src/a.js`` (bullet + backticks) or two paths
// joined on one line with `;` (#770's Files). Compared verbatim, neither equals a bare path, so
// the gate returned hasCollision:false for a pair that overlaps on TWO files. Normalize at parse
// time so the board and the gate agree on what a declared path is. The bullet strip requires
// whitespace after the marker, so a `**/*.js` glob survives it.
const BULLET = /^\s*[-*]\s+/
const NOT_A_PATH = (path) => path.startsWith('_(') || path.startsWith('#')

const normalizeEntry = (line) =>
  line
    .split(';')
    .map((part) => part.replace(BULLET, '').replace(/`/g, '').trim())
    .filter((part) => part && !NOT_A_PATH(part))

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

    // The placeholder/comment filter runs AFTER normalization, so a decorated `_(none listed)_`
    // is dropped by its normalized form rather than slipping through its `- ` prefix.
    if (inFiles && entry) entries.push(...normalizeEntry(entry))
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
    const collidingFiles = targetFiles.filter((f) => issueFiles.includes(f))

    if (collidingFiles.length) {
      return {
        hasCollision: true,
        collidingIssue: issue.number,
        collidingAgent: owner,
        // `collidingFile` stays the first match for existing callers; an agent deciding whether to
        // split needs the whole set, because the first file alone can look incidental.
        collidingFile: collidingFiles[0],
        collidingFiles,
      }
    }
  }

  return { hasCollision: false }
}

module.exports = {
  parseScope,
  checkScopeCollision,
}
