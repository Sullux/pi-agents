const { readdirSync, readFileSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

// #130: #122 makes a long-lived runner say which commit it loaded and how far that is behind the tip,
// and the note names "restart the runner" as the operator's next move. It can only speak from a process
// that HAS the module. Measured live: `pgrep -f 'page start'` returned seven daemons, five of them booted
// 03:24:48Z-03:25:25Z while `src/runner/code-currency.js` first appears at `1ce79a5` (01:59Z-0400 =
// 05:59Z), so five runners were structurally incapable of warning anyone - and nothing on the box could
// enumerate them. This is the operator-facing inversion of #122: not "am I current?" but "which of my
// siblings cannot say?". Read-only by construction: it names the restart, it never performs one.
//
// Same discipline as `src/cli/selfcheck.js` and `src/runner/code-currency.js`, duplicated deliberately
// rather than imported: git gets NO voice (an EXPECTED failure - a detached HEAD, a shallow reflog - must
// not leak `fatal:` lines into a session), `maxBuffer` is raised because pi-agents #4 was a fleet-wide
// ENOBUFS from the 1 MB default, and every read is individually survivable: if a value cannot be read the
// field is blank, never guessed, because a fabricated SHA is an accusation and a fabricated "current" is
// a lie - neither is a measurement.
const defaultRoot = join(__dirname, '..', '..')
const ANNOTATOR_PATH = 'src/runner/code-currency.js'
const VERBS = ['start', 'run']

const defaultGit = (cwd) => (args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 8 * 1024 * 1024,
  })

// One /proc walk, three fields per pid. `stat` is parsed after the LAST ')' because the comm field is
// "(agent name (pp))" shaped and can itself contain parentheses - the classic off-by-N that silently
// shifts every later field, and field 22 is the one we need.
const defaultProc = () => {
  const read = (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return ''
    }
  }
  const uptime = Number(read('/proc/uptime').split(/\s+/)[0])
  const bootEpochMs =
    Number.isFinite(uptime) && uptime > 0 ? Date.now() - uptime * 1000 : NaN
  return readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .map((name) => {
      const pid = Number(name)
      const argv = read(join('/proc', name, 'cmdline'))
        .split('\0')
        .filter(Boolean)
      const stat = read(join('/proc', name, 'stat'))
      const afterComm = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)
      return { pid, argv, starttimeTicks: Number(afterComm[19]), bootEpochMs }
    })
}

// The pid filter is the whole hazard: `pgrep -f 'page start'` also matches the bash wrapper that ran it,
// which is recorded twice in this fleet as an empty field in one's own probe output. So the test is the
// argv SHAPE - an entry that IS an executable page (the runtime root's bin, or a symlink ending /bin/page)
// followed by a runner verb - which a shell command line containing the phrase can never satisfy.
const runnerIndex = (argv) => {
  const at = argv.findIndex(
    (entry) =>
      /(^|\/)bin\/page$/.test(entry) ||
      entry === join(defaultRoot, 'bin', 'page'),
  )
  return at >= 0 && VERBS.includes(argv[at + 1]) ? at : -1
}

const firstAdd = (git) =>
  `${git(['log', '--diff-filter=A', '--format=%H', '--reverse', '--', ANNOTATOR_PATH])}`
    .trim()
    .split('\n')[0] || ''

const RunnerCurrency = ({
  cwd = defaultRoot,
  git = defaultGit(cwd),
  proc = defaultProc,
  selfPid = process.pid,
} = {}) => {
  const safe = (fn) => {
    try {
      return fn()
    } catch {
      return undefined
    }
  }
  const num = (text) => {
    const n = Number(`${text}`.trim())
    return Number.isFinite(n) ? n : NaN
  }

  // The reference is read from git, never hardcoded as a string literal in a message: the commit that
  // first ADDS the annotator on the shipped line is the moment a runner becomes able to describe itself.
  const reference = () =>
    safe(() => {
      const sha = firstAdd(git)
      const epoch = num(git(['log', '-1', '--format=%ct', sha])) * 1000
      if (!sha || !Number.isFinite(epoch)) return undefined
      return { sha: sha.slice(0, 7), epochMs: epoch }
    })

  // Newest retained reflog entry at or before the boot instant is what the process loaded. A boot older
  // than every entry prints 'older than the retained reflog' rather than the oldest SHA it happens to
  // have: a SHA that was not loaded is a fabricated provenance, and this fleet has been burned by
  // confident numbers about objects that were never in the tree.
  const loadedAt = (bootMs) =>
    safe(() => {
      const rows =
        `${git(['reflog', 'show', '--date=iso-strict', '--format=%H %ct', 'HEAD'])}`
          .trim()
          .split('\n')
          .map((line) => line.split(/\s+/))
          .map(([sha, ct]) => ({ sha, epoch: num(ct) * 1000 }))
          .filter(
            (row) =>
              row.sha && Number.isFinite(row.epoch) && row.epoch <= bootMs,
          )
      if (!rows.length) return ''
      const best = rows.reduce((a, b) => (b.epoch > a.epoch ? b : a))
      const behind =
        `${git(['rev-list', '--count', `${best.sha}..${'origin/main'}`])}`.trim()
      return `${best.sha.slice(0, 7)}${/^\d+$/.test(behind) ? ` (${behind} merges behind)` : ''}`
    })

  const census = () => {
    const ref = reference()
    const entries = safe(() => proc()) || []
    const runners = entries
      .filter((entry) => entry.pid !== selfPid && runnerIndex(entry.argv) >= 0)
      .map((entry) => {
        const bootMs = entry.bootEpochMs + (entry.starttimeTicks / 100) * 1000
        if (!Number.isFinite(bootMs) || !ref)
          return { pid: entry.pid, state: 'unmeasured', argv: entry.argv }
        return bootMs < ref.epochMs
          ? {
              pid: entry.pid,
              bootedAt: new Date(bootMs).toISOString(),
              state: 'cannot-warn',
              argv: entry.argv,
            }
          : {
              pid: entry.pid,
              bootedAt: new Date(bootMs).toISOString(),
              state: 'current',
              loaded: loadedAt(bootMs),
              argv: entry.argv,
            }
      })
    return {
      measured: runners.length > 0 && Boolean(ref),
      reference: ref,
      runners,
    }
  }

  const describe = (state = census()) => {
    if (!state.measured) return ''
    const mute = state.runners.filter((r) => r.state === 'cannot-warn')
    const live = state.runners.filter((r) => r.state === 'current')
    if (!mute.length && !live.length) return ''
    const head = `runner currency: ${mute.length} of ${state.runners.length} live 'page start' runners booted before ${state.reference.sha}, the commit that added ${ANNOTATOR_PATH};`
    return [
      mute.length
        ? `${head} those CANNOT emit the currency note - restart the runner (kill the pid and re-run 'page start')`
        : '',
      ...mute.map(
        (r) =>
          `  pid ${r.pid} booted ${r.bootedAt} - predates the annotator, prints no warning`,
      ),
      ...live.map(
        (r) =>
          `  pid ${r.pid} booted ${r.bootedAt} - loaded ${r.loaded || 'older than the retained reflog'}`,
      ),
    ]
      .filter(Boolean)
      .join('\n')
  }

  return { census, describe, runnerIndex }
}

module.exports = { RunnerCurrency, runnerIndex, ANNOTATOR_PATH }
