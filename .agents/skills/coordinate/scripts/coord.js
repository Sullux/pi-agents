#!/usr/bin/env node
// #816: this shim is the fleet's documented entry point, and it used to swallow the exit status -
// `page coord <unknown verb>` exits 1, but every call through here exited 0. Any script gating on
// `$?` (claim && start-work, a CI step, a `set -e` wrapper) therefore treated a REFUSED claim, a
// scope collision or a typo'd verb as success. Propagate the real status; `?? 1` covers a
// signal-kill, where spawnSync reports status null.
//
// #871: this is the THIRD copy of the shim, and the one `setup-agents.sh:28-30` runs at bootstrap.
// #865 hardened the copy profile.js provisions to `result.status ?? 1` plus an explicit
// `result.error` branch, but this tracked seed kept `process.exit(result.status || 0)` and had no
// error branch at all. `|| 0` and `?? 1` differ exactly where it matters: a non-zero status was
// already propagated by both, but spawnSync reports `status: null` for a signal-kill AND for a
// `page` that could not be run at all, and `null || 0` reads as SUCCESS. A bootstrap that never
// reached `page` would therefore believe the labels and hub were created, and setup-agents.sh's
// `|| { echo "Notice: ... returned non-zero" }` guard would never fire because there was nothing
// to catch.
//
// The status handling below is deliberately identical to the provisioned shim so there is one
// behaviour, not two. What is NOT identical, and must stay that way, is `findPageBin`: it
// resolves `<repo>/bin/page` four levels up from this file, which is what makes bootstrap work on
// a fresh clone where `page` is not on PATH yet. The provisioned copy spawns bare `page` and
// cannot do that, so overwriting either file with the other regresses one of the two consumers.
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

const findPageBin = () => {
  const localBin = path.resolve(__dirname, '../../../../bin/page')
  if (fs.existsSync(localBin)) {
    return localBin
  }
  return 'page'
}

const main = () => {
  const pageBin = findPageBin()
  const args = ['coord', ...process.argv.slice(2)]
  const result = spawnSync(pageBin, args, {
    stdio: 'inherit',
    env: process.env,
  })

  if (result.error) {
    console.error(`coord: cannot run \`page coord\`: ${result.error.message}`)
    process.exit(1)
  }

  process.exit(result.status ?? 1)
}

main()
