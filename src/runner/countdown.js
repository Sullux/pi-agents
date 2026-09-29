const waitInterruptible = async (seconds, reason = '', { stdin = process.stdin, stdout = process.stdout } = {}) => {
  stdout.write('\n-----------------------------------------------------------------\n')
  stdout.write(`  ${reason}\n`)
  stdout.write('-----------------------------------------------------------------\n')

  return new Promise((resolve) => {
    let elapsed = 0
    let intervalId = null

    const cleanup = (userCancelled = false) => {
      if (intervalId) clearInterval(intervalId)
      if (stdin.isTTY && stdin.setRawMode) {
        stdin.setRawMode(false)
        stdin.pause()
        stdin.removeListener('data', onData)
      }
      stdout.write('\n')
      resolve(userCancelled)
    }

    const onData = (data) => {
      const key = data.toString()
      if (key === '\u001B' || key === 'q' || key === 'Q' || key === '\r' || key === '\n') {
        stdout.write('\n[Agent Loop] User requested exit.\n')
        cleanup(true)
      }
    }

    if (stdin.isTTY && stdin.setRawMode) {
      stdin.setRawMode(true)
      stdin.resume()
      stdin.on('data', onData)
    }

    const render = () => {
      const remaining = Math.max(0, seconds - elapsed)
      stdout.write(`\r  Waiting ${String(remaining).padStart(2, ' ')}s... Press ESC, 'q', or Enter to stop the loop.`)
      if (elapsed >= seconds) {
        cleanup(false)
      }
      elapsed += 1
    }

    render()
    intervalId = setInterval(render, 1000)
  })
}

module.exports = {
  waitInterruptible,
}
