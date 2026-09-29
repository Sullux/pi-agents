#!/usr/bin/env node

const { GitHubClient } = require('./lib/github')
const { Commands } = require('./lib/commands')

const printHelp = () => {
  console.log(`
coord.js - multi-agent coordination over GitHub Issues via the gh CLI.
Protocol: ../SKILL.md and ../references/protocol.md
Usage:    node .agents/skills/coordinate/scripts/coord.js <command> [args]
Env:      COORD_AGENT (who you are), COORD_REPO, COORD_HUB, COORD_STALE_MIN

Commands:
  sync                                   board, your claims, stale, needs-human, hub tail
  board                                  open issues by ws/status/owner/files
  hub "text"                             post SYNC on the hub issue
  claim N [--plan T] [--eta T]           assign yourself (refuses if owned/scope clash)
  release N [--reason T] [--stale]       unassign
  status N "text"                        heartbeat + progress
  done N [--pr URL] ["text"]             close + mark done
  help                                   show this help
`)
}

const main = async () => {
  const args = process.argv.slice(2)
  if (
    !args.length ||
    args.includes('--help') ||
    args.includes('-h') ||
    args[0] === 'help'
  ) {
    printHelp()
    return 0
  }

  const command = args[0]
  const github = GitHubClient({ repo: process.env.COORD_REPO })
  const cmd = Commands({ github, agent: process.env.COORD_AGENT })

  try {
    if (command === 'sync') {
      const output = await cmd.sync()
      console.log(output)
      return 0
    }

    if (command === 'board') {
      const output = await cmd.board()
      console.log(output)
      return 0
    }

    if (command === 'hub') {
      const text = args.slice(1).join(' ')
      if (!text) {
        console.error('Usage: coord hub "text"')
        return 1
      }
      const output = await cmd.hub(text)
      console.log(output)
      return 0
    }

    if (command === 'claim') {
      const num = Number(args[1])
      if (!num) {
        console.error('Usage: coord claim <issue_number> [--plan T] [--eta T]')
        return 1
      }
      const planIdx = args.indexOf('--plan')
      const etaIdx = args.indexOf('--eta')
      const plan = planIdx !== -1 ? args[planIdx + 1] : ''
      const eta = etaIdx !== -1 ? args[etaIdx + 1] : ''
      const output = await cmd.claim(num, { plan, eta })
      console.log(output)
      return 0
    }

    if (command === 'release') {
      const num = Number(args[1])
      if (!num) {
        console.error(
          'Usage: coord release <issue_number> [--reason T] [--stale]',
        )
        return 1
      }
      const reasonIdx = args.indexOf('--reason')
      const reason = reasonIdx !== -1 ? args[reasonIdx + 1] : ''
      const stale = args.includes('--stale')
      const output = await cmd.release(num, { reason, stale })
      console.log(output)
      return 0
    }

    if (command === 'status') {
      const num = Number(args[1])
      const text = args.slice(2).join(' ')
      if (!num || !text) {
        console.error('Usage: coord status <issue_number> "text"')
        return 1
      }
      const output = await cmd.status(num, text)
      console.log(output)
      return 0
    }

    if (command === 'done') {
      const num = Number(args[1])
      if (!num) {
        console.error('Usage: coord done <issue_number> [--pr URL] ["text"]')
        return 1
      }
      const prIdx = args.indexOf('--pr')
      const pr = prIdx !== -1 ? args[prIdx + 1] : ''
      const text = args
        .filter((a, i) => i > 1 && i !== prIdx && i !== prIdx + 1)
        .join(' ')
      const output = await cmd.done(num, { pr, text })
      console.log(output)
      return 0
    }

    console.error(`Unknown command: ${command}`)
    printHelp()
    return 1
  } catch (err) {
    console.error(`coord: ${err.message}`)
    return 1
  }
}

main().then((code) => process.exit(code || 0))
