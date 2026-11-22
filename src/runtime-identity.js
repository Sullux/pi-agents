const path = require('node:path')
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')

const defaultGitHead = (dir) =>
  execFileSync('git', ['-C', dir, 'rev-parse', '--short=9', 'HEAD'], {
    encoding: 'utf8',
  }).trim()

// #167 box 5: the fleet can see that everyone is running and cannot see WHAT each is running -
// the same invisibility that makes #166's stale-runner restart hazard undetectable from the board.
// This resolves the invoked binary to its real path and the commit behind its checkout, so
// `page status` and every session record name the runtime that computed them. Related to #166
// (wave state) but deliberately not merged with it: this is binary identity, that is liveness.
//
// DI shape matches Provenance/CodeCurrency/RunnerCurrency: the non-deterministic reads (realpath,
// git) arrive through the factory and a test hands it a fake. A directory that is not a git
// checkout answers 'not a git checkout' - a legitimate reading, not a swallowed error.
const RuntimeIdentity =
  ({
    argv1 = process.argv[1],
    realpath = fs.realpathSync,
    gitHead = defaultGitHead,
  } = {}) =>
  () => {
    const resolved = realpath(argv1)
    let commit
    try {
      commit = gitHead(path.dirname(resolved))
    } catch {
      commit = 'not a git checkout'
    }
    return { path: resolved, commit }
  }

module.exports = { RuntimeIdentity, defaultGitHead }
