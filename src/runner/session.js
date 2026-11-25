const { spawn } = require('node:child_process')
const path = require('node:path')
const {
  DEFAULT_QW_COMPACT_PERCENT,
  syncCompactionSettings,
} = require('../config/compaction')
const {
  DEFAULT_QW_CONTEXT_WINDOW,
  syncModelContextOverride,
} = require('../config/modelOverride')
const { SessionActivityProbe } = require('./sessionActivity')

const runPiSession = async ({
  targetPath,
  prompt,
  steering = '',
  model,
  thinking,
  continueSession = true,
  env = {},
  spawnImpl = spawn,
  activityProbe = SessionActivityProbe(),
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

  const activeModel = model || 'qw/qwen4-max'
  const isQwModel = String(activeModel).startsWith('qw/')
  const parsedWindow = env.CONTEXT_WINDOW
    ? Number(env.CONTEXT_WINDOW)
    : undefined
  const contextWindow =
    Number.isFinite(parsedWindow) && parsedWindow > 0
      ? parsedWindow
      : isQwModel
        ? DEFAULT_QW_CONTEXT_WINDOW
        : undefined
  const compactPercent =
    env.COMPACT_PERCENT || (isQwModel ? DEFAULT_QW_COMPACT_PERCENT : 60)

  syncModelContextOverride({
    model: activeModel,
    contextWindow,
  })
  syncCompactionSettings({
    model: activeModel,
    contextWindow: contextWindow || 262144,
    percent: compactPercent,
  })

  const basePrompt =
    prompt || 'Proceed with development using the coordinate skill.'
  const fullPrompt = steering
    ? `${basePrompt} Explicit steering from user: ${steering}`
    : basePrompt
  args.push(fullPrompt)

  const childEnv = {
    ...process.env,
    ...(isQwModel && !env.COMPACT_PERCENT
      ? { COMPACT_PERCENT: String(DEFAULT_QW_COMPACT_PERCENT) }
      : {}),
    ...env,
    PI_AUTO_EXIT: '1',
  }

  const before = activityProbe.snapshot(targetPath)

  return new Promise((resolve, reject) => {
    const child = spawnImpl('pi', args, {
      cwd: targetPath,
      env: childEnv,
      stdio: 'inherit',
    })

    child.on('close', (code) => {
      const activity = activityProbe.inspectTurn
        ? activityProbe.inspectTurn(targetPath, before)
        : activityProbe.inspectDelta(targetPath, before)
      resolve({ code, ...activity })
    })

    child.on('error', (err) => {
      reject(err)
    })
  })
}

module.exports = {
  runPiSession,
}
