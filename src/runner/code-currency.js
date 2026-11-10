const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

// #122: the runner is a LONG-LIVED process, so the code that composes an agent's prompt was loaded
// when `page start` ran - not when the agent spawned. `src/cli/selfcheck.js` (#18, #74, #75, #21)
// makes the *directory* honest: tree SHA vs upstream tip, tracked dirt vs untracked paths. For a
// daemon the directory is not what runs. Measured the day this was written: the daemon that spawned
// this session (pid 2421893, `page start Bravo pp`) booted 2026-11-10T03:24:50Z, when the tree sat
// at `57e6a9c`; eight merges landed before the agent it spawned at 05:37:30Z received its prompt, and
// the advice in that prompt - "raise ISSUE_PAGE_CEILING (currently 500) or pass a larger
// options.limit" for a CLOSED-axis sweep - is text current `src/github/index.js` cannot produce for
// that axis (`f3a4e04` split the advice by axis; `b7ea65f` bounded the closed read server-side). The
// tree printed no provenance warning because the tree really was current. The process was not.
//
// Mutating coord verbs are NOT exposed - they run as fresh `page coord` processes off the current
// tree. What this covers is what the daemon computes itself: the prompt text, `checkBacklogAvailability`'s
// idle/busy verdict (#59), the review-gap classifier (#90/#92/#93) and the closure sweep (#99/#101/#107).
//
// Advice, not enforcement - the rule `selfcheck.js` states for the tree half, and it applies with the
// same force here: a guard that throws or blocks becomes the new outage on the thing it exists to
// report on. Every git read is individually survivable; if a SHA cannot be read the note is
// suppressed, never guessed, because a fabricated "fresh" is a lie and a fabricated "stale" is an
// accusation, and neither is a measurement.
const PACKAGE_ROOT = join(__dirname, '..', '..')
const MAX_GIT_BUFFER = 8 * 1024 * 1024

// #21's discipline, duplicated deliberately rather than imported from `src/cli/selfcheck.js`: git gets
// no voice (an EXPECTED failure - a detached HEAD, a missing upstream - must not leak `fatal:` lines
// into a session while the note claims to degrade quietly), and maxBuffer is raised because pi-agents
// #4 was a fleet-wide ENOBUFS from the 1 MB default.
const defaultGit = (cwd) => (args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: MAX_GIT_BUFFER,
  })

const short = (sha = '') => sha.slice(0, 7)

const ageMinutes = (bootMs, nowMs) =>
  Math.max(0, Math.round((nowMs - bootMs) / 60000))

// The commit-count phrase is where an operator learns how much merged behavior is missing, so a
// missing answer degrades to "unknown" rather than to a number: `rev-list --count` on a SHAs-that-
// exist pair can still fail (a shallow clone, a grafted object), and `Number('')` is 0 - which would
// print "+0 commits" about a tree that moved and quietly imply "nothing you are missing".
const countPhrase = (raw) => {
  if (raw === '') return ', commit count unknown (git could not answer)'
  const behind = Number(raw)
  if (!Number.isFinite(behind))
    return ', commit count unknown (git could not answer)'
  if (behind === 0)
    return ', and the tree moved to a ref that is not a descendant - the branch was switched'
  return ` - ${behind} merge${behind === 1 ? '' : 's'} landed since`
}

const CodeCurrency = ({
  git = defaultGit(PACKAGE_ROOT),
  now = Date.now,
} = {}) => {
  // one try/catch per reading, so a missing git or a non-repo degrades a field, not the cycle
  const read = (args) => {
    try {
      return `${git(args) ?? ''}`.trim()
    } catch {
      return ''
    }
  }

  // captured ONCE, at construction: this is the SHA whose bytes are in memory
  const loadedSha = read(['rev-parse', 'HEAD'])
  const bootMs = now()

  const describe = () => {
    if (!loadedSha) return ''
    const tipSha = read(['rev-parse', 'HEAD'])
    if (!tipSha) return ''
    if (tipSha === loadedSha) return ''
    const newest = read(['log', '-1', '--format=%cI', tipSha])
    const mins = ageMinutes(bootMs, now())
    return (
      `Code currency: this runner loaded ${short(loadedSha)} at boot and the tree now sits at ${short(tipSha)}` +
      `${countPhrase(read(['rev-list', '--count', `${loadedSha}..HEAD`]))}` +
      `${newest ? ` (newest commit ${newest})` : ''}. ` +
      `Every prompt and preflight verdict in this session was computed by the older code - it has been running ${mins} min. ` +
      `Restart the runner (page start <agent> <project>) to pick up the merged behavior; this note advises only - nothing was refused, skipped or downgraded.`
    )
  }

  return { loadedSha, bootMs, describe }
}

module.exports = { CodeCurrency, PACKAGE_ROOT }
