# Architecture: `page` (Pi Agent Orchestration Engine)

## 1. Vision & Overview

`page` is a CLI and runtime engine designed to operationalize autonomous, self-organizing multi-agent development swarms using the **Pi Framework** and **GitHub Issues**.

The paradigm was developed during the `pitcairn-portal` project, proving that autonomous agents can collaborate concurrently on complex software repositories without central locks, human micro-management, or loss of auditability.

The foundational design relies on two complementary pillars:
1. **GitHub Issues as Shared Decentralized Memory**: Issues act as backlog work orders, structured protocol comments act as an immutable audit trail and state machine, and Git branches/PRs provide code fences.
2. **Pi Framework as the Interactive Execution Harness**: Pi provides rich LLM interaction, tool use, thinking streams, inspectable `jsonl` session persistence, and hookable lifecycle extensions.

`page` bottles this pattern into an auditable, repeatable developer tool: managing agent workspaces, project enrollments, environment isolation, coordination protocol enforcement, and turn-based autonomous execution.

---

## 2. Core Architectural Principles

- **Auditable & Vanilla JavaScript**: Built in clean, modern CommonJS (CJS) Node.js without TypeScript, transpilation, or heavy third-party runtimes. Uses Node's built-in test runner (`node:test`) and standard library.
- **Functional Style**: Factories over classes, `const` over `let`, immutability over mutation, comprehensions over loops, and dependency injection for all non-deterministic operations (time, network, filesystem, child processes).
- **Milliseconds Timestamps**: Native JavaScript epoch millisecond timestamps (`Date.now()`) across all internal state and data models.
- **Physical Workspace Isolation**: Every agent gets its own directory tree (`~/agents/<agent>/<project-alias>/`). Agents never share local working trees or git staging areas.
- **Preserve Interactive TUI First**: Support individual terminal windows and tiled workspace grids where the human developer can watch Pi's live thinking, tool calls, and progress in real time, while architecting cleanly for headless/daemon execution in the future.
- **Single GitHub Identity Swarms**: Recognize that all local agents typically authenticate under a single developer GitHub token/PAT (`@charles` or `@Sullux`). Coordination identity must live in the protocol comments (`agent: <callsign>`), never in GitHub's native user-assignee field.

---

## 3. Directory Layout & Workspace Model

The system cleanly separates global engine configuration, agent identity, project repositories, and instance-specific runtime configurations:

```text
~/.config/page/                          # Global engine configuration
├── config.json                          # Engine settings (workspace root, editor, defaults)
├── projects.json                        # Project registry
└── agents.json                          # Agent registry

~/agents/                                # Workspace root (configurable)
├── .extension/                          # Centralized Pi extension (auto-compact & guidance)
│   ├── index.js                         # Auto-compaction & system prompt injection
│   └── package.json
│
├── alpha/                               # Agent Workspace: Alpha
│   ├── agent.json                       # Agent configuration (model, thinking, compaction)
│   ├── AGENTS.md                        # Agent-level persona & standing guidance
│   ├── projects/                        # Agent × Project configurations (OUTSIDE the repo)
│   │   ├── pp.env                       # Environment variables for 'pp'
│   │   ├── pp.md                        # Standing role guidance for Alpha on 'pp'
│   │   └── pp.json                      # Per-project overrides (optional model/thinking)
│   │
│   ├── pp/                              # Git clone: Pitcairn Portal (alias: pp)
│   └── carma/                           # Git clone: Carma (alias: carma)
│
├── bravo/                               # Agent Workspace: Bravo
│   ├── agent.json
│   ├── AGENTS.md
│   ├── projects/
│   │   ├── pp.env
│   │   └── pp.md
│   └── pp/
│
└── charlie/                             # Agent Workspace: Charlie
    ...
```

### Why Repos are Cloned per Agent
Disk space is cheap; developer and agent attention is expensive. Dedicated clones eliminate Git workspace collisions:
- No index locks or branch switching conflicts while an agent is running a build or test suite.
- Agents can run uncommitted discrimination probes or worktrees without dirtying a peer's tree.
- Long-running dev servers or test workers can hold open file handles without blocking other agents.

---

## 4. The 4-Tier Configuration Matrix

Configuration complexity in multi-agent swarms exists in an $N \times M$ matrix ($N$ agents running against $M$ projects). To avoid collisions and prevent brittle hardcoding, configuration is resolved in four clear tiers:

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Global Engine Scope (~/.config/page/)                    │
│    - Workspace root path (~/agents)                         │
│    - Default editor ($EDITOR / nano)                        │
│    - Default coordination polling intervals                 │
├──────────────────────────────┬──────────────────────────────┤
│ 2. Agent Scope               │ 3. Project Scope             │
│    - Callsign (agent-alpha)  │    - GitHub Repo & Alias     │
│    - Default Model & Thinking│    - Backlog labels & rules  │
│    - Context Thresholds      │    - Template .env.page      │
│    - Agent Persona (AGENTS.md│    - Assigned agent roster   │
├──────────────────────────────┴──────────────────────────────┤
│ 4. Agent × Project Intersection (~/agents/<agent>/projects/) │
│    - Runtime environment variables (e.g. PORT, DB, SOCKET)   │
│    - Project-specific role guidance (e.g. backend lead)      │
│    - Model overrides (e.g. use faster model on doc repo)     │
└─────────────────────────────────────────────────────────────┘
```

### Why Instance Configurations Live Outside the Repo
Keeping `~/agents/<agent>/projects/<project-alias>.env` outside the Git clone (`~/agents/<agent>/<project-alias>/`) guarantees:
1. **Safety from Git destruction**: Commands like `git clean -fdx` or `git checkout -- .` run by an agent during a reset cannot wipe out instance configuration or local SQLite files.
2. **Zero commit pollution**: Instance configurations cannot be accidentally staged, committed, or pushed to GitHub.
3. **Auditable inspection**: A human or supervisor script can inspect and edit the agent's exact environment without touching working tree state.

### Why Environment Configuration is Generalized (Not Port-Specific)
Different projects isolate local multi-instance execution in fundamentally different ways:
- **Web apps**: May require different TCP ports (`PORT=3001`, `PORT=3002`).
- **Inference engines (e.g., Channel)**: May require unique Unix domain socket paths (`SOCKET_PATH=/tmp/channel-alpha.sock`).
- **Database-driven apps**: May require separate SQLite database paths (`DB_PATH=./var/test-alpha.db`) or schema names.
- **Shared libraries (e.g., `@sullux/tui`)**: Require zero networking or port configuration.

Rather than baking an opinionated `--port-base` flag into the CLI, `page` provides **generalized environment variable templates**:
- Projects can define an optional `.env.page` template in their repository:
  ```ini
  PORT={{port}}
  DB_PATH=./var/test-{{agent}}.db
  SOCKET_PATH=/tmp/{{project}}-{{agent}}.sock
  ```
- When a project is added to agents, variables can be substituted or generated automatically, and then fine-tuned via `page env edit <agent> <project>`.

---

## 5. Coordination Engine (`page coord`)

The bash implementation (`coord.sh`) suffered from critical concurrency defects when multiple agents shared a single GitHub account. The coordination engine is rewritten in tested vanilla Node.js as a native component of `page`.

### Key Protocol Invariants

1. **Protocol Comments as Authoritative Ownership**:
   - Every state transition is recorded in an issue comment starting with a bold verb:
     `**CLAIM** | agent: agent-alpha | human: @charles | at: 1711530000000`
   - Issue assignees in GitHub are purely cosmetic for human GitHub UI visibility.
   - Ownership resolution parses the structured protocol comments. If Agent Bravo attempts to claim an issue where the latest active claim belongs to `agent-alpha`, the claim is rejected—even though both agents authenticate as the same GitHub user.

2. **Simultaneous Claim Race Resolution**:
   - If two agents claim the same issue concurrently, the agent with the earlier `createdAt` comment timestamp wins.
   - The loser detects the earlier timestamp on its verification pass, posts a `**RELEASE** | lost claim race to agent-X`, and exits back to backlog polling.

3. **Dynamic Repository Resolution**:
   - Repository target is resolved from:
     1. Explicit `--repo` CLI flag
     2. Project registry lookup via working directory
     3. `git remote get-url origin`
   - Hardcoded repo fallbacks are eliminated.

4. **Label Healing**:
   - GitHub labels (`status:claimed`, `status:in-progress`, `status:blocked`) are a lossy projection of the comment stream. The coordination engine reads the comment log to verify true state, and automatically reconciles/repairs drifted labels.

5. **Declared Scope Enforcement**:
   - Claims require non-empty `## Files` scope declarations to prevent silent overlapping edits across agents.

---

## 6. Autonomous Agent Execution Loop

The execution loop governs how an agent behaves when running autonomously.

```
       ┌───────────────────────────────┐
       │         page run              │
       │ (Load env, cd to clone, etc.) │
       └───────────────┬───────────────┘
                       │
                       ▼
         ┌───────────────────────────┐
         │ Check Backlog & PR Status │◄──────────────────┐
         └─────────────┬─────────────┘                   │
                       │                                 │
         ┌─────────────┴─────────────┐                   │
   [Ready: Unclaimed]          [Empty / Busy]            │
         │                           │                   │
         ▼                           ▼                   │
┌──────────────────┐       ┌───────────────────┐         │
│  Start Pi Turn   │       │ Interruptible     │         │
│ (TUI or Headless)│       │ Sleep (60s / 300s)│─────────┘
└────────┬─────────┘       └───────────────────┘
         │
         ▼
┌──────────────────┐
│ Turn Settles     │
│ (Auto-compaction)│
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Exit Pi Session  │
│ (PI_AUTO_EXIT=1) │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Check Stop Signal│────[Stop Requested]───► Exit Cleanly
└────────┬─────────┘
         │ [Continue]
         └───────────────────────────────────────────────┘
```

### Thundering Herd Prevention
The legacy `start` script woke up all idle agents whenever any open PR appeared, causing simultaneous, redundant reviews.

The new engine implements **role-aware backlog resolution**:
- Distinguishes between **unclaimed issues** (backlog work) and **open PRs** (review work).
- Staggers agent polling intervals using slight randomized jitter (e.g. 60s ± 10s) to prevent simultaneous API burst calls.
- Can designate PR review responsibilities to specific agents or round-robin review claims.

### Clean Interruptibility & Lifecycle Control
The runner maintains state in `~/.config/page/state/<agent>-<project>.json`:
- **Graceful Stop**: `page stop <agent> <project>` sets `stopRequested: true`. The runner allows the current Pi turn to settle cleanly, executes any auto-compaction, releases locks, and exits without re-executing.
- **Hard Stop**: `page stop <agent> <project> --kill` sends `SIGINT` / `SIGTERM` to the active Pi child process and halts immediately.
- **State Reporting**: The runner constantly updates its status (`idle_empty`, `idle_busy`, `running_turn`, `cooldown`, `stopped`) with turn counters and claimed issue numbers.

---

## 7. Pi Extension: Auto-Compact & Prompt Composition

Instead of copying `.pi` folders into every cloned repository, `page` maintains a single canonical extension and points Pi to it at runtime (`pi -e ~/.config/page/extension`).

The extension provides two critical functions:

### 1. Dynamic System Prompt Composition
Pi's system prompt is enriched on session start by dynamically concatenating guidance layers in decreasing order of generality:
1. **Universal Protocol Memories**: Core multi-agent collaboration memories (from global `AGENTS.md`).
2. **Project Guidelines**: Shared project architecture, coding standards, and build/test instructions (from `<repo>/AGENTS.md` or `projects.json`).
3. **Agent Persona**: Agent callsign, assigned port/socket details, and persona rules (from `~/agents/<agent>/AGENTS.md`).
4. **Agent × Project Standing Guidance**: Specific duties for this agent on this project (from `~/agents/<agent>/projects/<project-alias>.md`).

This eliminates filesystem path hacking and guarantees every agent has the exact right context on every turn.

### 2. Model-Aware Compaction & Auto-Settlement
- **Configurable Compaction Thresholds**: Rather than hardcoding 160k tokens (which breaks on 128k context models and wastes space on 1M context models), the threshold is read from the agent's `agent.json` (e.g. `compactAtPercent: 20` or `compactAtTokens: 150000`).
- **Domain-Specific Compaction Instructions**: Instructs Pi's compaction summarizer to preserve active GitHub claim numbers, branch names, contract interfaces, and pending reviewer blockers.
- **Settlement Exit**: When `process.env.PI_AUTO_EXIT === '1'` is set by the runner, the extension intercepts `agent_settled`, verifies compaction status, and calls `ctx.shutdown()` to return control to the loop.

---

## 8. CLI Command Specification (`page`)

The `page` CLI provides an ergonomic interface for managing projects, agents, configurations, and running swarms.

### Global & Configuration
```bash
page config list                     # View all global configuration settings
page config set <key> <value>        # Set configuration (e.g. editor nano, agentsRoot ~/agents)
```

### Project Management (`page project`)
```bash
page project add <repo-or-url> [--alias <alias>] [--agents <list>]
                                     # Register project, clone into assigned agent directories,
                                     # setup coordinate labels/hub, and template .env files
page project list                    # List registered projects, repos, aliases, and assigned agents
page project show <alias>            # Show project details, branches, and active agent statuses
page project edit <alias>            # Open project configuration/guidance in $EDITOR
page project remove <alias> [--clean]# Remove project from registry (optionally delete agent clones)
```

### Agent Management (`page agent`)
```bash
page agent add <name> [--model <m>] [--thinking <level>]
                                     # Create agent directory, identity AGENTS.md, and configuration
page agent list                      # List all agents, models, assigned projects, and statuses
page agent show <name>               # Show agent details, active claims, and recent cycles
page agent edit <name>               # Open agent AGENTS.md in $EDITOR
page agent set <name> [--model <m>] [--thinking <level>]
                                     # Update agent model/thinking settings
```

### Environment & Guidance Management (`page env`, `page guide`)
```bash
page env edit <agent> <project>      # Open ~/agents/<agent>/projects/<project>.env in $EDITOR
page env show <agent> <project>      # Print resolved environment variables for this agent/project
page guide edit <agent> <project>    # Open ~/agents/<agent>/projects/<project>.md in $EDITOR
```

### Swarm Execution & Supervision (`page run`, `page stop`, `page status`)
```bash
page run <agent> <project> [--steering "message"]
                                     # Run agent loop in foreground (interactive Pi TUI)
page stop <agent> <project> [--kill] # Request graceful stop (or immediate kill)
page status [project]                # Display live status table of agents, states, and claimed issues
```

### Coordination Tooling (`page coord`)
```bash
page coord sync                      # Synchronize with coordination board and hub
page coord board                     # View open issues by workstream, status, owner, and files
page coord claim <issue>             # Claim an issue with plan and files validation
page coord release <issue>           # Release an issue claim
page coord status <issue> "text"     # Post heartbeat / status progress update
page coord done <issue> [--pr <url>] # Complete issue and notify dependent issues
```

---

## 9. Stretch Goals & Future Evolution

1. **Multiplexed Monitoring Dashboard (`@sullux/tui`)**:
   - A single-screen terminal console displaying all active agents across projects.
   - Status indicators (idle, working, waiting on PR, error), CPU/memory usage, and current token context percentage.
   - Filterable live streams of thinking and tool invocations across agents.
2. **Daemon Mode**:
   - Background execution with log capture (`page logs <agent> <project> -f`) for truly unattended operation when interactive terminal windows are not needed.
