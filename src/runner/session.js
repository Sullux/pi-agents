const { spawn } = require('node:child_process')
const path = require('node:path')
const { syncCompactionSettings } = require('../config/compaction')

const runPiSession = async ({
  targetPath,
  prompt,
  steering = '',
  model,
  thinking,
  continueSession = true,
  env = {},
  spawnImpl = spawn,
} = {}) => {
  const extensionPath = path.resolve(
    __dirname,
    '../../pi/extensions/auto-compact.ts',
  )
  const args = ['--approve']
  if (continueSession) args.unshift('--continue')

  if (model) args.push('--model', model)
  if (thinking) args.push('--thinking', thinking)
  if (extensionPath) args.push('--extension', extensionPath)

  syncCompactionSettings({
    model: model || 'qw/qwen3.8-max',
    percent: env.COMPACT_PERCENT || 60,
  })

  const basePrompt =
    prompt || 'Proceed with development using the coordinate skill.'
  const fullPrompt = steering
    ? `${basePrompt} Explicit steering from user: ${steering}`
    : basePrompt
  args.push(fullPrompt)

  const childEnv = {
    ...process.env,
    ...env,
    PI_AUTO_EXIT: '1',
  }

  return new Promise((resolve, reject) => {
    const child = spawnImpl('pi', args, {
      cwd: targetPath,
      env: childEnv,
      stdio: 'inherit',
    })

    child.on('close', (code) => {
      resolve({ code })
    })

    child.on('error', (err) => {
      reject(err)
    })
  })
}

module.exports = {
  runPiSession,
}
