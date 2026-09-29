const { spawn } = require('node:child_process')
const path = require('node:path')

const runPiSession = async ({
  targetPath,
  prompt = 'Proceed with development using the coordinate skill.',
  model,
  thinking,
  env = {},
  spawnImpl = spawn,
} = {}) => {
  const extensionPath = path.resolve(
    __dirname,
    '../../pi/extensions/auto-compact.ts',
  )
  const args = ['--continue', '--approve']

  if (model) args.push('--model', model)
  if (thinking) args.push('--thinking', thinking)
  if (extensionPath) args.push('--extension', extensionPath)
  args.push(prompt)

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
