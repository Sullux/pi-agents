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
// #863: a `split: #N,#M` line is an AGREEMENT, not a path. The bash variant documents it as the
// remedy for a collision and pitcairn #831 carries a live one (`split: #813,#830`), but the
// entry filter only dropped `#`- and `_(`-prefixed lines, so that waiver was parsed as a bogus
// path and compared against other issues' declarations.
const SPLIT_LINE = /^(\^)?split:/i
// #10: a comment fragment must never become a path. Stripping an annotation can leave a bare
// `-->` on the following line when an author opens `<!--` and closes it later, and that token
// starts with none of the prefixes the filter knows, so it would be compared as a declared path.
const COMMENT_FRAGMENT = /^(<!--|-->)/
const NOT_A_PATH = (path) =>
  path.startsWith('_(') ||
  path.startsWith('#') ||
  SPLIT_LINE.test(path) ||
  COMMENT_FRAGMENT.test(path)

// #10: annotations arrive ON the path line - `src/a.js <!-- minted by #896 -->` - and the entry was
// compared verbatim afterwards, so the annotated token equalled no real path and the file silently
// LEFT the collision set. Measured on pitcairn #896: its Files line declared
// `test/e2e/admin-nav.spec.js  <!-- ... -->`, and `paths.includes('test/e2e/admin-nav.spec.js')` was
// false through the canonical parser. Stripped BEFORE the `;` split, because an annotation that
// contains a semicolon would otherwise be cut into extra bogus paths. Comments are a per-line
// affair: an opening `<!--` runs to end of line, and its `-->` is dropped as a fragment above.
const HTML_COMMENT = /[ \t]*<!--[\s\S]*/g
const normalizeEntry = (line) =>
  line
    .replace(HTML_COMMENT, '')
    .split(';')
    .map((part) => part.replace(BULLET, '').replace(/`/g, '').trim())
    .filter((part) => part && !NOT_A_PATH(part))

// #863: the issue numbers a `split:` line waives. Line-anchored and fence-skipping, so a
// documented EXAMPLE of the syntax does not silently grant a real waiver.
const parseSplits = (body = '') => {
  const numbers = new Set()
  let inFence = false

  for (const line of body.split('\n')) {
    const entry = line.trim()
    if (FENCE.test(entry)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (!SPLIT_LINE.test(entry)) continue
    for (const match of entry.matchAll(/#(\d+)/g)) numbers.add(Number(match[1]))
  }

  return numbers
}

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

const labelNames = (issue) =>
  (issue?.labels || []).map((l) => (typeof l === 'string' ? l : l.name))

const statusOf = (issue) =>
  labelNames(issue)
    .find((name) => name?.startsWith('status:'))
    ?.replace('status:', '') || 'unclaimed'

// #863: `in-review` means the work is FINISHED and awaiting a human or a teammate, so fencing
// files against it blocks new work with completed work - measured 4 of 5 unclaimed issues frozen
// this way on 2026-10-26, and #820 still frozen on 2026-10-27. The remedy for a second author is
// a rebase after the merge, so it warns. `claimed`, `in-progress` and `blocked` are live edits
// and still refuse.
const SOFT_STATUSES = ['in-review']

const checkScopeCollision = (
  targetFiles = [],
  activeIssues = [],
  currentAgent = '',
  target = {},
) => {
  const cleanCurrent = cleanAgent(currentAgent)
  const splitsHere = parseSplits(target.body)

  const overlaps = []
  for (const issue of activeIssues) {
    const owner = ownerOf(issue)
    if (!owner || owner === cleanCurrent) continue

    const issueFiles = parseScope(issue.body)
    const collidingFiles = targetFiles.filter((f) => issueFiles.includes(f))
    if (!collidingFiles.length) continue

    // A recorded split waives the pair in EITHER direction, which is the remedy the bash
    // variant documents and the only protocol exit this gate has.
    const waived =
      splitsHere.has(issue.number) || parseSplits(issue.body).has(target.number)
    if (waived) continue

    overlaps.push({
      issue: issue.number,
      agent: owner,
      status: statusOf(issue),
      files: collidingFiles,
      soft: SOFT_STATUSES.includes(statusOf(issue)),
    })
  }

  const warnings = overlaps.filter((o) => o.soft)
  const hard = overlaps.find((o) => !o.soft)

  if (hard) {
    return {
      hasCollision: true,
      collidingIssue: hard.issue,
      collidingAgent: hard.agent,
      collidingStatus: hard.status,
      // `collidingFile` stays the first match for existing callers; an agent deciding whether to
      // split needs the whole set, because the first file alone can look incidental.
      collidingFile: hard.files[0],
      collidingFiles: hard.files,
      warnings,
    }
  }

  return { hasCollision: false, warnings }
}

module.exports = {
  parseScope,
  parseSplits,
  labelNames,
  statusOf,
  checkScopeCollision,
}
