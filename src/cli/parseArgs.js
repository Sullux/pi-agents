const parseArgs = (argv = []) => {
  const args = [...argv]
  if (
    !args.length ||
    args.includes('--help') ||
    args.includes('-h') ||
    args[0] === 'help'
  ) {
    return { command: 'help', positionals: [], flags: {} }
  }

  const command = args.shift()
  const positionals = []
  const flags = {}

  // #28: a flag that carries no value must not swallow the token after it. The loop is greedy by
  // design (--repo <r>, --pr <n>, --plan <p> all read the NEXT arg as their value), so a boolean
  // has to be declared. Measured before the fix: `coord done 21 --force "attested"` put the
  // message into flags.force and left `positionals` empty, so the **DONE** comment went out
  // header-only and the attestation the message exists to carry was silently dropped.
  // Only flags proven valueless at every call site belong here - the rest keep today's shape.
  const valueless = new Set(['force', 'kill'])

  let i = 0
  while (i < args.length) {
    const item = args[i]
    if (item.startsWith('--')) {
      const key = item.slice(2)
      if (key.includes('=')) {
        const [k, v] = key.split('=')
        flags[k] = v
        i += 1
      } else if (
        !valueless.has(key) &&
        i + 1 < args.length &&
        !args[i + 1].startsWith('-')
      ) {
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
