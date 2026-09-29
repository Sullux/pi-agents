#!/usr/bin/env node

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
  process.exit(result.status || 0)
}

main()
