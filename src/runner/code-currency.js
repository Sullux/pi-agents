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

// #152: the reference is the MERGED tip, never the tree pointer. `describe()` used to compare
// `rev-parse HEAD` at boot against `rev-parse HEAD` now, and this checkout - `/home/charles/sullux/pi-agents`,
// which `readlink -f $(which page)` resolves to for EVERY agent - is shared mutable state that peers
// move with `git checkout`. Measured live: a runner booted at `4f60f02` printed "the tree now sits at
// 4e57472 - 2 merges landed since ... pick up the merged behavior" while `origin/main` was still
// exactly `4f60f02`, `gh pr view 147` said `state=OPEN mergedAt=null`, and one of those two commits
// (`4de78c4`) is not a merge at all. The note was therefore advising a fleet-wide restart onto
// unreviewed code, in prose, with nothing refusing it. So: classify the move by counting commits in
// each direction against `origin/main` - the same discriminator `src/cli/selfcheck.js` uses for the
// tree half ("Trusted means the bytes ARE the merged upstream tip") and `src/cli/runner-currency.js`
// already uses for the census - and count COMMITS, since a commit count is not a merge count.
//
// Counts are read as stdout (`rev-list --count`), not as an exit status, because `read()` swallows
// errors by design: `merge-base --is-ancestor` answers 0-vs-1 and would arrive as '' either way.
// `origin/main` is a LOCAL remote-tracking ref and this module never fetches - a daemon that fetched
// on every prompt cycle would be a new outage on the thing it reports - so this can be stale by
// however long the last fetch was. That is the same bound `selfcheck.js` accepts, and it is a bound
// on "how much merged work am I missing", never on the safety claim: a stale `origin/main` can only
// under-report main's advance, and the unmerged branch below errs toward NOT advising a restart.
// An unanswered read is NOT zero. `Number('') === 0`, so a `rev-list --count` that failed would
// arrive as 0 = "the tree contains nothing main lacks" = merged - which is the precise false claim
// #152 exists to remove, rebuilt out of a coercion. The old `countPhrase` guarded `raw === ''` for
// exactly this reason; the guard has to live here now that two counts answer different questions.
const num = (raw) => {
  const text = `${raw}`.trim()
  const n = Number(text)
  return text !== '' && Number.isFinite(n) ? n : NaN
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

const where = (branch, tip) =>
  branch ? `branch ${branch}` : `a detached HEAD at ${short(tip)}`

// how far the loaded commit sits behind the MERGED tip, in the operator's terms. Three answers, and
// the unknown one is deliberately not zero: `rev-list --count` can fail on a shallow clone or a
// grafted object, and `Number('')` is 0 - which would print "no merged behavior is missing" about a
// tree git could not measure (the same reason `selfcheck.js` prints 'unknown' for ahead/behind).
const behindClause = (behind, loaded) =>
  Number.isNaN(behind)
    ? 'how far main sits ahead of it is unknown (git could not answer)'
    : behind === 0
      ? `your loaded ${short(loaded)} IS main's tip, so no merged behavior is missing`
      : `main is ${plural(behind, 'commit')} ahead of what you loaded`

// the same distance, read from a tree that IS on main's line - the case #122 was built for
const landedClause = (behind) =>
  Number.isNaN(behind)
    ? 'commit count unknown (git could not answer)'
    : behind === 0
      ? 'main has not moved since you booted - the tree switched to an older commit on the same line, so a restart would load OLDER code'
      : `- ${plural(behind, 'commit')} of merged behavior landed since`

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
    const head =
      `Code currency: this runner loaded ${short(loadedSha)} at boot and the tree now sits at ${short(tipSha)}` +
      `${newest ? ` (newest commit ${newest})` : ''} - it has been running ${mins} min. `
    const advice =
      'this note advises only - nothing was refused, skipped or downgraded.'

    // no merged tip to compare against: say the tree moved, refuse to characterise it (#122's rule -
    // a fabricated "fresh" is a lie, a fabricated "stale" is an accusation, and a fabricated
    // "merged" is an instruction to load unreviewed code)
    const mainSha = read(['rev-parse', '--verify', 'origin/main'])
    if (!mainSha)
      return (
        `${head}the merged tip could not be read (no origin/main), so this note cannot say whether ` +
        `${short(tipSha)} is merged behavior or someone's unmerged branch; do not restart on the ` +
        `strength of this note alone; ${advice}`
      )

    const unmerged = num(
      read(['rev-list', '--count', `origin/main..${tipSha}`]),
    )
    const behind = num(
      read(['rev-list', '--count', `${loadedSha}..origin/main`]),
    )
    const branch = read(['symbolic-ref', '--short', '-q', 'HEAD'])
    const mergedClause = behindClause(behind, loadedSha)

    // git could not count either direction: report the move, characterise nothing
    if (Number.isNaN(unmerged))
      return `${head}the tree moved but its relationship to main (${short(mainSha)}) could not be counted; ${mergedClause}; ${advice}`

    // the tree holds commits main does not: someone's checkout, not shipped code
    if (unmerged > 0)
      return (
        `${head}that is ${plural(unmerged, 'commit')} main (${short(mainSha)}) does NOT contain - the ` +
        `checkout has been moved onto ${where(branch, tipSha)}, so this is UNMERGED work, not shipped ` +
        `behavior, and restarting the runner would load it. ${mergedClause}. Leave the checkout alone if ` +
        `a peer is reviewing there (it is every agent's runtime); 'git checkout main && git pull --ff-only' ` +
        `restores it once they are done; ${advice}`
      )

    // the tree is on main's line: count what is missing against main, not against the tree pointer
    return (
      `${head}${landedClause(behind)}. ` +
      `Every prompt and preflight verdict in this session was computed by the older code. ` +
      `Restart the runner (page start <agent> <project>) to pick up the merged behavior; ${advice}`
    )
  }

  return { loadedSha, bootMs, describe }
}

module.exports = { CodeCurrency, PACKAGE_ROOT }
