const { parseArgs } = require('./parseArgs')
const { ConfigLoader } = require('../config')
const { WorkspaceManager } = require('../workspace')
const { GitHubClient, resolveRepoFromRemote } = require('../github')
const { CoordService } = require('../coord')
const { Runner } = require('../runner')

const printHelp = () => {
  console.log(`
Usage: page <command> [subcommand] [args...] [flags]

Commands:
  project list                       List registered projects
  project add <alias> <repo>         Register a project repository
  project show <alias>               Show project details

  agent list                         List registered agents
  agent add <name> [--model <m>]     Register an agent
  agent show <name>                  Show agent details

  env show <agent> <project>         Show resolved environment variables

  coord board [--repo <r>]           Display coordination board
  coord claim <issue> [--plan <p>]   Claim an issue
  coord release <issue> [--reason <r>] Release a claim
  coord status <issue> <text>        Post progress update
  coord done <issue> [--pr <n>]      Mark issue completed

  run <agent> <project>              Run autonomous agent execution loop
`)
}

const Cli = ({ configLoader = ConfigLoader(), stdout = console.log, stderr = console.error } = {}) => {
  const run = async (argv = process.argv.slice(2)) => {
    const { command, positionals, flags } = parseArgs(argv)

    if (command === 'help') {
      printHelp()
      return 0
    }

    if (command === 'project') {
      const sub = positionals[0]
      if (sub === 'list') {
        const list = configLoader.project.list()
        stdout(list.length ? list.map((p) => `• ${p}`).join('\n') : 'No registered projects.')
        return 0
      }
      if (sub === 'add') {
        const [, alias, repo] = positionals
        if (!alias || !repo) {
          stderr('Usage: page project add <alias> <repo>')
          return 1
        }
        configLoader.project.save(alias, { repo, defaultEnv: {} })
        stdout(`Registered project '${alias}' -> ${repo}`)
        return 0
      }
      if (sub === 'show') {
        const [, alias] = positionals
        const proj = configLoader.project.load(alias)
        if (!proj) {
          stderr(`Project '${alias}' not found.`)
          return 1
        }
        stdout(JSON.stringify(proj, null, 2))
        return 0
      }
    }

    if (command === 'agent') {
      const sub = positionals[0]
      if (sub === 'list') {
        const list = configLoader.agent.list()
        stdout(list.length ? list.map((a) => `• ${a}`).join('\n') : 'No registered agents.')
        return 0
      }
      if (sub === 'add') {
        const [, name] = positionals
        if (!name) {
          stderr('Usage: page agent add <name>')
          return 1
        }
        const sys = configLoader.getSystemConfig()
        configLoader.agent.save(name, {
          model: flags.model || sys.defaultModel,
          thinking: flags.thinking || sys.defaultThinking,
          env: {},
        })
        stdout(`Registered agent '${name}'`)
        return 0
      }
      if (sub === 'show') {
        const [, name] = positionals
        const ag = configLoader.agent.load(name)
        if (!ag) {
          stderr(`Agent '${name}' not found.`)
          return 1
        }
        stdout(JSON.stringify(ag, null, 2))
        return 0
      }
    }

    if (command === 'env' && positionals[0] === 'show') {
      const [, agent, project] = positionals
      if (!agent || !project) {
        stderr('Usage: page env show <agent> <project>')
        return 1
      }
      const env = configLoader.resolveInstanceEnv(agent, project)
      stdout(JSON.stringify(env, null, 2))
      return 0
    }

    if (command === 'coord') {
      const sub = positionals[0]
      const repo = flags.repo || ''
      const github = GitHubClient({ repo })
      const agent = process.env.COORD_AGENT || 'agent-cli'
      const coord = CoordService({ github, agent })

      if (sub === 'board') {
        stdout(await coord.board())
        return 0
      }
      if (sub === 'claim') {
        const issueNum = Number(positionals[1])
        const res = await coord.claim(issueNum, { plan: flags.plan, eta: flags.eta })
        if (!res.ok) {
          stderr(`Error: ${res.error}`)
          return 1
        }
        stdout(`Claimed #${issueNum}`)
        return 0
      }
      if (sub === 'release') {
        const issueNum = Number(positionals[1])
        const res = await coord.release(issueNum, { reason: flags.reason })
        stdout(`Released #${issueNum}`)
        return 0
      }
      if (sub === 'status') {
        const issueNum = Number(positionals[1])
        const msg = positionals.slice(2).join(' ')
        await coord.status(issueNum, msg)
        stdout(`Status updated on #${issueNum}`)
        return 0
      }
      if (sub === 'done') {
        const issueNum = Number(positionals[1])
        await coord.done(issueNum, { pr: flags.pr })
        stdout(`Marked #${issueNum} done`)
        return 0
      }
    }

    if (command === 'run') {
      const [agent, project] = positionals
      if (!agent || !project) {
        stderr('Usage: page run <agent> <project>')
        return 1
      }
      const sys = configLoader.getSystemConfig()
      const ag = configLoader.agent.load(agent) || {}
      const env = configLoader.resolveInstanceEnv(agent, project)
      const workspace = WorkspaceManager({ fs: require('node:fs'), agentsRoot: sys.agentsRoot })
      const targetPath = workspace.getWorkspacePath(agent, project)
      const github = GitHubClient({ cwd: targetPath })

      const runner = Runner({
        github,
        agent,
        targetPath,
        model: flags.model || ag.model || sys.defaultModel,
        thinking: flags.thinking || ag.thinking || sys.defaultThinking,
        env,
      })

      const maxCycles = flags['max-cycles'] ? Number(flags['max-cycles']) : Infinity
      const result = await runner.runLoop({ maxCycles })
      return result.stopped ? 0 : 1
    }

    printHelp()
    return 1
  }

  return { run }
}

module.exports = { Cli }
