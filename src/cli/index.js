const { execSync } = require('node:child_process')
const { parseArgs } = require('./parseArgs')
const { HubText } = require('./hubText')
const { ConfigLoader } = require('../config')
const { WorkspaceManager } = require('../workspace')
const { GitHubClient } = require('../github')
const { CoordService } = require('../coord')
const { Runner, SessionTracker } = require('../runner')
const { pad } = require('../coord/formatters')
const { requireIssueNumber, requireMessage } = require('../coord/issueNumber')
const { Provenance } = require('./selfcheck')

const printHelp = () => {
  console.log(`
Usage: page <command> [subcommand] [args...] [flags]

Global Flags:
  -p, --profile <name>               Target a specific profile (default: active profile)

Session Commands:
  start <agent> <project>            Start single autonomous agent session in this terminal
  stop <agent> [--kill]              Stop an active agent session
  status [project]                   Display active agent sessions

Profile Commands:
  profiles list                      List all registered profiles (* marks active)
  profiles add <name> <path>         Register a profile root directory
  profiles remove <name>             Unregister a profile
  profiles show [name]               Show profile details
  use <name>                         Set active persistent profile

Project Commands:
  projects list                      List registered projects
  projects add <repo> [--alias <a>]  Register a project repository
  projects show <alias>              Show project details
  projects remove <alias>            Unregister a project

Agent Commands:
  agents list                        List registered agents
  agents add <name> [--model <m>]    Register an agent
  agents show <name>                 Show agent details

Coordination Commands:
  coord board [--repo <r>]           Display coordination board
  coord sync                         Synchronize status, claims, and hub
  coord claim <issue> [--plan <p>]   Claim an issue
  coord release <issue> [--reason]   Release an issue claim
  coord status <issue> <text>        Post heartbeat progress update
  coord done <issue> [--pr <n>]      Mark issue completed
  coord hub <text>                   Post update to coordination hub
  coord hub --body-file <path>       Post update from a markdown file
  coord provenance                   Report which checkout and commit are running

System Commands:
  env show <agent> <project>         Show resolved environment variables
  update                             Self-update page to latest version
`)
}

const formatUptime = (ms = 0) => {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

const Cli = ({
  configLoader: customLoader,
  sessionTracker: customTracker,
  coordFactory: customCoord,
  provenance = Provenance(),
  stdout = console.log,
  stderr = console.error,
} = {}) => {
  const run = async (argv = process.argv.slice(2)) => {
    const { command, positionals, flags } = parseArgs(argv)

    if (command === 'help' || flags.help || flags.h) {
      printHelp()
      return 0
    }

    const loader = customLoader || ConfigLoader({ flags })
    const tracker =
      customTracker || SessionTracker({ agentsRoot: loader.agentsRoot })

    if (command === 'use') {
      const name = positionals[0]
      if (!name) {
        stderr('Usage: page use <profile_name>')
        return 1
      }
      loader.profile.useProfile(name)
      stdout(`Switched active profile to '${name}'`)
      return 0
    }

    if (command === 'profiles' || command === 'profile') {
      const sub = positionals[0]
      if (sub === 'list') {
        const list = loader.profile.listProfiles()
        const active = loader.profile.resolveActiveProfileName(flags)
        if (!list.length) {
          stdout('No profiles registered.')
          return 0
        }
        stdout(
          list
            .map(
              (p) => `${p.name === active ? '* ' : '  '}${p.name} (${p.path})`,
            )
            .join('\n'),
        )
        return 0
      }
      if (sub === 'add') {
        const [, name, targetPath] = positionals
        if (!name || !targetPath) {
          stderr('Usage: page profiles add <name> <path>')
          return 1
        }
        const profile = loader.profile.addProfile(name, targetPath)
        stdout(`Added profile '${name}' at ${profile.path}`)
        return 0
      }
      if (sub === 'remove') {
        const [, name] = positionals
        if (!name) {
          stderr('Usage: page profiles remove <name>')
          return 1
        }
        const removed = loader.profile.removeProfile(name)
        if (!removed) {
          stderr(`Profile '${name}' not found.`)
          return 1
        }
        stdout(`Removed profile '${name}'`)
        return 0
      }
      if (sub === 'show') {
        const name =
          positionals[1] || loader.profile.resolveActiveProfileName(flags)
        const p = loader.profile.getProfile(name)
        if (!p) {
          stderr(`Profile '${name}' not found.`)
          return 1
        }
        stdout(JSON.stringify(p, null, 2))
        return 0
      }
    }

    if (command === 'projects' || command === 'project') {
      const sub = positionals[0]
      if (sub === 'list') {
        const list = loader.project.list()
        stdout(
          list.length
            ? list.map((p) => `• ${p}`).join('\n')
            : 'No registered projects.',
        )
        return 0
      }
      if (sub === 'add') {
        const repo = positionals[1]
        if (!repo) {
          stderr('Usage: page projects add <repo> [--alias <alias>]')
          return 1
        }
        const alias =
          flags.alias ||
          repo
            .split('/')
            .pop()
            .replace(/\.git$/, '')
        loader.project.save(alias, { repo, defaultEnv: {} })

        const agents = loader.agent.list()
        if (agents.length) {
          const ws = WorkspaceManager({
            fs: require('node:fs'),
            agentsRoot: loader.agentsRoot,
          })
          for (const ag of agents) {
            if (!ws.exists(ag, alias)) {
              ws.provisionInstanceFiles(ag, alias)
            }
          }
        }

        stdout(`Registered project '${alias}' -> ${repo}`)
        return 0
      }
      if (sub === 'show') {
        const [, alias] = positionals
        const proj = loader.project.load(alias)
        if (!proj) {
          stderr(`Project '${alias}' not found.`)
          return 1
        }
        stdout(JSON.stringify(proj, null, 2))
        return 0
      }
    }

    if (command === 'agents' || command === 'agent') {
      const sub = positionals[0]
      if (sub === 'list') {
        const list = loader.agent.list()
        stdout(
          list.length
            ? list.map((a) => `• ${a}`).join('\n')
            : 'No registered agents.',
        )
        return 0
      }
      if (sub === 'add') {
        const [, name] = positionals
        if (!name) {
          stderr('Usage: page agents add <name>')
          return 1
        }
        const sys = loader.getSystemConfig()
        loader.agent.save(name, {
          model: flags.model || sys.defaultModel,
          thinking: flags.thinking || sys.defaultThinking,
          env: {},
        })

        const projects = loader.project.list()
        const ws = WorkspaceManager({
          fs: require('node:fs'),
          agentsRoot: loader.agentsRoot,
        })
        for (const pr of projects) {
          ws.provisionInstanceFiles(name, pr)
        }

        stdout(`Registered agent '${name}'`)
        return 0
      }
      if (sub === 'show') {
        const [, name] = positionals
        const ag = loader.agent.load(name)
        if (!ag) {
          stderr(`Agent '${name}' not found.`)
          return 1
        }
        stdout(JSON.stringify(ag, null, 2))
        return 0
      }
    }

    if (command === 'status') {
      const projectFilter = positionals[0]
      const sessions = tracker.listSessions(projectFilter)
      if (!sessions.length) {
        stdout(
          projectFilter
            ? `No active agent sessions running for project '${projectFilter}'.`
            : 'No active agent sessions running.',
        )
        return 0
      }

      const header = `${pad('AGENT', 12)} ${pad('PROJECT', 12)} ${pad('PID', 8)} ${pad('STATUS', 16)} ${pad('UPTIME', 10)}`
      const lines = [header]

      for (const s of sessions) {
        const uptime = formatUptime(Date.now() - s.startedAt)
        lines.push(
          `${pad(s.agent, 12)} ${pad(s.project, 12)} ${pad(String(s.pid), 8)} ${pad(s.status, 16)} ${pad(uptime, 10)}`,
        )
      }
      stdout(lines.join('\n'))
      return 0
    }

    if (command === 'stop') {
      const agent = positionals[0]
      if (!agent) {
        stderr('Usage: page stop <agent> [--kill]')
        return 1
      }
      const res = tracker.stopSession(agent, { kill: Boolean(flags.kill) })
      if (!res.ok) {
        stderr(`Error: ${res.error}`)
        return 1
      }
      stdout(`Stopped agent '${agent}' (pid: ${res.pid})`)
      return 0
    }

    if (command === 'start' || command === 'run') {
      const [agent, project] = positionals
      if (!agent || !project) {
        stderr(`Usage: page ${command} <agent> <project> [--steering <msg>]`)
        return 1
      }

      const projConfig = loader.project.load(project)
      if (!projConfig) {
        stderr(
          `Error: Project '${project}' is not registered. Run 'page projects add <repo> --alias ${project}' first.`,
        )
        return 1
      }

      const sys = loader.getSystemConfig()
      let ag = loader.agent.load(agent)
      if (!ag) {
        stdout(`[page] Agent '${agent}' not found in profile. Registering...`)
        loader.agent.save(agent, {
          model: flags.model || sys.defaultModel,
          thinking: flags.thinking || sys.defaultThinking,
          env: {},
        })
        ag = loader.agent.load(agent) || {}
      }

      const workspace = WorkspaceManager({
        fs: require('node:fs'),
        agentsRoot: loader.agentsRoot,
      })

      if (!workspace.exists(agent, project)) {
        const target = workspace.getWorkspacePath(agent, project)
        stdout(`[page] Project workspace not found at ${target}.`)
        stdout(`[page] Cloning ${projConfig.repo}...`)
        workspace.clone(agent, project, projConfig.repo)
      }

      const env = loader.resolveInstanceEnv(agent, project)
      if (sys.compaction?.defaultPercent && !env.COMPACT_PERCENT) {
        env.COMPACT_PERCENT = String(sys.compaction.defaultPercent)
      }
      if (sys.compaction?.modelOverrides && !env.COMPACT_MODEL_OVERRIDES) {
        env.COMPACT_MODEL_OVERRIDES = JSON.stringify(
          sys.compaction.modelOverrides,
        )
      }
      if (ag.compactPercent && !env.COMPACT_PERCENT) {
        env.COMPACT_PERCENT = String(ag.compactPercent)
      }
      if (ag.compactTokens && !env.COMPACT_TOKENS) {
        env.COMPACT_TOKENS = String(ag.compactTokens)
      }
      if (flags['compact-percent']) {
        env.COMPACT_PERCENT = String(flags['compact-percent'])
      }
      if (flags['compact-tokens']) {
        env.COMPACT_TOKENS = String(flags['compact-tokens'])
      }

      const targetPath = workspace.getWorkspacePath(agent, project)
      const github = GitHubClient({ cwd: targetPath })

      stdout(`[page] Starting agent '${agent}' on project '${project}'...`)
      stdout(`[page] Working directory: ${targetPath}`)

      const runner = Runner({
        github,
        agent,
        project,
        targetPath,
        steering: flags.steering || '',
        model: flags.model || ag.model || sys.defaultModel,
        thinking: flags.thinking || ag.thinking || sys.defaultThinking,
        env,
        sessionTracker: tracker,
      })

      const maxCycles = flags['max-cycles']
        ? Number(flags['max-cycles'])
        : Infinity
      const result = await runner.runLoop({ maxCycles })
      return result.stopped ? 0 : 1
    }

    if (command === 'update') {
      stdout('[page] Updating @sullux/page to the latest version...')
      try {
        execSync('npm install -g @sullux/page', { stdio: 'inherit' })
        stdout('[page] Updated successfully!')
        return 0
      } catch (err) {
        stderr(`[page] Update failed: ${err.message}`)
        return 1
      }
    }

    if (command === 'env' && positionals[0] === 'show') {
      const [, agent, project] = positionals
      if (!agent || !project) {
        stderr('Usage: page env show <agent> <project>')
        return 1
      }
      const env = loader.resolveInstanceEnv(agent, project)
      stdout(JSON.stringify(env, null, 2))
      return 0
    }

    if (command === 'coord') {
      const sub = positionals[0]
      // #18: this checkout IS the installed program, so an agent's verdict is only as trustworthy as
      // the tree the shim happened to exec. `provenance` is the on-demand readout, and for that verb
      // describe() below is the whole answer, so the advisory is not doubled.
      if (sub === 'provenance') {
        stdout(provenance.describe())
        return 0
      }
      // ADVISORY ONLY: stderr, never stdout (agents grep the board), and it changes no exit code.
      // Best-effort by design: a subordinate diagnostic that throws would take down the very command
      // it exists to report on, which is the #18 outage all over again. The `provenance` verb above
      // is deliberately NOT guarded - there the readout IS the command, so a failure must be loud.
      try {
        const advisory = provenance.note()
        if (advisory) stderr(advisory)
      } catch {}
      const repo = flags.repo || ''
      const github = GitHubClient({ repo })
      const agent = process.env.COORD_AGENT || 'agent-cli'
      const coord = customCoord
        ? customCoord({ github, agent })
        : CoordService({ github, agent })

      if (sub === 'board') {
        stdout(await coord.board())
        return 0
      }
      if (sub === 'sync') {
        stdout(await coord.sync())
        return 0
      }
      if (sub === 'hub') {
        const hubText = HubText((path) =>
          require('node:fs').readFileSync(path, 'utf8'),
        )
        const resolved = hubText(flags, positionals.slice(1).join(' '))
        if (resolved.error) {
          stderr(resolved.error)
          return 1
        }
        const posted = await coord.hub(resolved.text)
        if (!posted.ok) {
          stderr(posted.error)
          return 1
        }
        stdout(`Posted to hub #${posted.hubNumber}`)
        return 0
      }
      // Every mutating verb below addresses one issue, and a missing positional
      // used to become `Number(undefined)` = NaN and reach a real `gh` write
      // against issue "NaN" (pi-agents#13). `failed` prints the first validation
      // error so all five refuse in exactly one shape.
      const failed = (...steps) => {
        const bad = steps.find((step) => step && step.error)
        if (!bad) return false
        stderr(bad.error)
        return true
      }
      if (sub === 'claim') {
        const num = requireIssueNumber('claim', positionals[1])
        if (failed(num)) return 1
        const res = await coord.claim(num.value, {
          plan: flags.plan,
          eta: flags.eta,
        })
        if (!res.ok) {
          stderr(`Error: ${res.error}`)
          return 1
        }
        stdout(`Claimed #${num.value}`)
        // #863: an in-review overlap warns rather than fences. Printing it here is what makes the
        // warning real - the claim still succeeded, so the agent needs to be told a rebase is owed.
        for (const w of res.warnings || []) {
          stdout(
            `  ! overlaps #${w.issue} (${w.status}, held by ${w.agent}) on ${w.files.join(', ')} - rebase after it merges`,
          )
        }
        return 0
      }
      if (sub === 'release') {
        const num = requireIssueNumber('release', positionals[1])
        if (failed(num)) return 1
        const res = await coord.release(num.value, { reason: flags.reason })
        // The four verbs below used to print success without reading `res`, so a
        // service-level refusal (including the #13 guard) stayed invisible. The
        // success line is what made a failed write look like a completed one.
        if (!res.ok) {
          stderr(`Error: ${res.error}`)
          return 1
        }
        stdout(`Released #${num.value}`)
        return 0
      }
      if (sub === 'status') {
        const num = requireIssueNumber('status', positionals[1])
        const msg = requireMessage('status', positionals.slice(2).join(' '))
        if (failed(num, msg)) return 1
        const res = await coord.status(num.value, msg.value)
        if (!res.ok) {
          stderr(`Error: ${res.error}`)
          return 1
        }
        stdout(`Status updated on #${num.value}`)
        return 0
      }
      if (sub === 'review') {
        const num = requireIssueNumber('review', positionals[1])
        const msg = requireMessage('review', positionals.slice(2).join(' '))
        if (failed(num, msg)) return 1
        const res = await coord.review(num.value, {
          pr: flags.pr,
          text: msg.value,
        })
        if (!res.ok) {
          stderr(`Error: ${res.error}`)
          return 1
        }
        stdout(`Moved #${num.value} to in-review`)
        return 0
      }
      if (sub === 'done') {
        const num = requireIssueNumber('done', positionals[1])
        if (failed(num)) return 1
        const res = await coord.done(num.value, { pr: flags.pr })
        if (!res.ok) {
          stderr(`Error: ${res.error}`)
          return 1
        }
        stdout(`Marked #${num.value} done`)
        return 0
      }
    }

    printHelp()
    return 1
  }

  return { run }
}

module.exports = { Cli }
