const parseArgs = (argv = []) => {
  const args = [...argv]
  if (!args.length || args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    return { command: 'help', positionals: [], flags: {} }
  }

  const command = args.shift()
  const positionals = []
  const flags = {}

  let i = 0
  while (i < args.length) {
    const item = args[i]
    if (item.startsWith('--')) {
      const key = item.slice(2)
      if (key.includes('=')) {
        const [k, v] = key.split('=')
        flags[k] = v
        i += 1
      } else if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        flags[key] = args[i + 1]
        i += 2
      } else {
        flags[key] = true
        i += 1
      }
    } else if (item.startsWith('-')) {
      flags[item.slice(1)] = true
      i += 1
    } else {
      positionals.push(item)
      i += 1
    }
  }

  return { command, positionals, flags }
}

module.exports = {
  parseArgs,
}
