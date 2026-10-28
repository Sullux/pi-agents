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
// #26: a setext underline is heading punctuation, never a path. Measured before the fix: a body
// with an ATX `## Files` followed by a setext `Notes` + `----` returned
// ["src/a.js", "Notes", "-----", "y"] - three junk paths from three prose lines, and a `-----`
// token collides with every other converted issue that declares one. The section walk also skips
// each underline explicitly; this filter is what makes a stray one (a thematic break between two
// path lines) impossible to emit.
const SETEXT_UNDERLINE = /^\s*[-=]{3,}\s*$/
const UNDERLINE_TOKEN = /^[-=]{3,}$/
const NOT_A_PATH = (path) =>
  path.startsWith('_(') ||
  path.startsWith('#') ||
  UNDERLINE_TOKEN.test(path) ||
  SPLIT_LINE.test(path) ||
  COMMENT_FRAGMENT.test(path)

// #26: setext headings. `Files` followed immediately by a line of `-----` (or `=====`) declares
// the same section as `## Files`, and `Notes` + `-----` closes it the same way `## Notes` does.
// Adjacency is required, not merely "the next non-empty line": in CommonMark a `----` after a
// blank line is a thematic break, and treating a rule as a heading would close a section on
// content that divides it. Mirrors the ATX forms the parser already accepts: `## Files` is a
// PREFIX (`## Files (paths)` opens), so the setext text uses \b rather than an exact match.
const FILES_NAME = /^files\b/i
const isSetextHeading = (lines, i) =>
  (lines[i] ?? '').trim() !== '' &&
  SETEXT_UNDERLINE.test(lines[i + 1] ?? '') &&
  !SETEXT_UNDERLINE.test(lines[i])

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
  const lines = body.split('\n')
  let inFence = false
  let inFiles = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const entry = line.trim()

    if (FENCE.test(entry)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    // #26: the underline belongs to the heading, so it is consumed here rather than left to the
    // token filter - a section opener that also emits its own punctuation is how the next reader
    // gets a `-----` in their scope list.
    const opensFiles = /^## Files/.test(line)
    const opensSetext = isSetextHeading(lines, i) && FILES_NAME.test(entry)
    if (opensFiles || opensSetext) {
      inFiles = true
      if (opensSetext) i += 1
      continue
    }
    // Any other H2 closes the section, exactly as the old `\n##` terminator did. An H3
    // subsection stays content - it is dropped by the `#` filter below, unchanged. A setext
    // heading closes it too, which is the half that stops prose from becoming paths.
    if (/^## /.test(line) || isSetextHeading(lines, i)) {
      inFiles = false
      if (isSetextHeading(lines, i)) i += 1
      continue
    }

    // The placeholder/comment filter runs AFTER normalization, so a decorated `_(none listed)_`
    // is dropped by its normalized form rather than slipping through its `- ` prefix.
    if (inFiles && entry) entries.push(...normalizeEntry(entry))
  }

  return entries
}

// #26 box 5: `declares no Files scope` was a catch-all for "the parser could not see mine", which
// sent authors hunting for a missing section that was sitting right there under a heading style the
// reader ignored. The claim path now names WHICH failure it is, so an unclaimable issue says why in
// its own words.
const filesSectionDiagnosis = (body = '') => {
  const lines = body.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const entry = (lines[i] ?? '').trim()
    if (FENCE.test(entry)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const heading =
      /^##\s+Files\b/i.test(entry) ||
      (isSetextHeading(lines, i) && FILES_NAME.test(entry))
    if (heading) {
      return parseScope(body).length
        ? 'the Files section parsed fine'
        : 'a Files heading exists but its section names no paths'
    }
  }
  return 'no Files heading in either form (## Files, or Files followed by ----)'
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
  filesSectionDiagnosis,
  labelNames,
  statusOf,
  checkScopeCollision,
}
