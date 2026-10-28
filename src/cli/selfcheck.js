const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

// #18: in THIS repo the checkout IS the installed program - no build step, no node_modules, and
// `which page` resolves to `.../pi-agents/bin/page`, so whatever the shared directory holds is
// what every agent's coord verdict was computed from, and no output ever said so. Measured the day
// this was written: a sibling's mid-probe marker left a SyntaxError in src/coord/formatters.js and
// `page coord board` died in BOTH repos; afterwards the fleet's board ran unmerged code on an
// unpushed branch while printing `== board ==` as if nothing differed.
//
// The visibility half, and it ADVISES rather than enforces: note on STDERR (a warning inside the
// board's own output would break every agent grepping it), no exit-code change, no refusal - a
// guard that throws or blocks becomes the new outage on the command it exists to report on. Every
// git read is individually survivable; if nothing can be read the note is suppressed, not guessed.
const defaultRoot = join(__dirname, '..', '..')

const defaultGit = (cwd) => (args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    // #21: execFileSync forwards the child's stderr to the terminal by default, so a probe that is
    // EXPECTED to fail - a detached HEAD has no @{u} - leaked two `fatal:` lines into every agent's
    // session while the note claimed to degrade silently. git gets no voice here; this module
    // decides what the reader sees. maxBuffer is raised because pi-agents #4 was a fleet-wide
    // ENOBUFS from the same 1 MB default, and an oversized read just throws into safe().
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 8 * 1024 * 1024,
  })

const Provenance = ({ cwd = defaultRoot, git = defaultGit(cwd) } = {}) => {
  // one try/catch per reading, so a missing git or a non-repo degrades one field, not the command
  const safe = (args) => {
    try {
      return `${git(args) ?? ''}`.trim()
    } catch {
      return ''
    }
  }

  // Which ref counts as "the tip" depends on the SHAPE, because `@{u}` cannot resolve on a detached
  // HEAD (#21: treating the empty answer as drift falsely accused every review worktree, which is
  // the normal shape of a review, of not being the merged tip). A branch compares against its own
  // upstream - an empty answer there genuinely means unpushed, and the fallback must NOT be
  // reachable from that path, or an unpushed branch would be reassured with 'upstream tip'.
  const tipFor = (isBranch) =>
    (isBranch ? ['@{u}'] : ['origin/HEAD', 'origin/main'])
      .map((ref) => ({ ref, sha: safe(['rev-parse', '--short', ref]) }))
      .find((entry) => entry.sha !== '') ?? { ref: '', sha: '' }

  const read = () => {
    const sha = safe(['rev-parse', '--short', 'HEAD'])
    const name = safe(['symbolic-ref', '--short', '-q', 'HEAD'])
    const tip = tipFor(name !== '')
    const counts = tip.ref
      ? safe(['rev-list', '--left-right', '--count', `${tip.ref}...HEAD`])
      : ''
    const [behind, ahead] = counts.split(/\s+/).map((n) => Number(n) || 0)
    return {
      cwd,
      sha,
      // no symbolic ref means detached, which is fine when it sits on the tip
      branch: name || 'detached',
      dirty: safe(['status', '--porcelain']) !== '',
      upstreamSha: tip.sha,
      tipRef: tip.ref,
      ahead: ahead || 0,
      behind: behind || 0,
      measured: sha !== '',
    }
  }

  // Trusted means the bytes ARE the merged upstream tip: a detached HEAD at that sha counts,
  // because the verdict depends on the code and not the ref name, and an unpushed branch (no
  // upstream) never does.
  const isTrusted = (state = read()) =>
    state.measured &&
    state.upstreamSha !== '' &&
    state.sha === state.upstreamSha &&
    !state.dirty &&
    state.ahead === 0 &&
    state.behind === 0

  const note = (state = read()) => {
    if (!state.measured || isTrusted(state)) return ''
    const moves = [
      state.dirty ? 'dirty' : '',
      state.ahead > 0 ? `+${state.ahead}` : '',
      state.behind > 0 ? `-${state.behind}` : '',
    ]
      .filter(Boolean)
      .join(' ')
    // three readings, and 'upstream tip' only when the sha genuinely equals it: an unpushed branch
    // must not be described as the tip, and `abc vs abc` would hide the real reason (dirty/branch)
    const drift = !state.upstreamSha
      ? 'no upstream'
      : state.sha === state.upstreamSha
        ? 'upstream tip'
        : `${state.sha} vs ${state.upstreamSha}`
    return [
      'coord note: running from',
      `${state.cwd} @${state.sha}`,
      `(${state.branch}${moves ? `, ${moves}` : ''}, ${drift}) -`,
      "NOT the merged tip: another agent's coord may compute a different answer",
    ].join(' ')
  }

  const describe = (state = read()) => {
    const trust = isTrusted(state) ? 'merged tip' : 'NOT the merged tip'
    const known = (field, value) => (state.measured ? value : field)
    return [
      `path       ${state.cwd}`,
      `sha        ${known('unknown', state.sha)}`,
      `branch     ${known('unknown', state.branch)}`,
      `worktree   ${known('unknown', state.dirty ? 'dirty' : 'clean')}`,
      `upstream   ${state.upstreamSha ? `${state.upstreamSha} (via ${state.tipRef})` : 'none'}`,
      `drift      ${state.upstreamSha ? `${state.ahead} ahead / ${state.behind} behind` : 'unknown'}`,
      `trust      ${trust}`,
    ].join('\n')
  }

  return { read, isTrusted, note, describe }
}

module.exports = { Provenance, defaultRoot }
