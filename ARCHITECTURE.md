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
- **Physical Workspace Isolation & Profiles**: Every agent gets its own directory tree (`<profile-root>/<agent>/<project-alias>/`). Agents never share local working trees or git staging areas. Workspaces are partitioned by **Profiles** (e.g. `personal`, `work`) with separate roots, credentials, and drive mounts.
- **Strict Project Agnosticism**: Target repositories remain 100% agnostic to how contributors choose to work. A project repo never contains `@sullux/page` in its dependencies or swarm-specific tooling committed into its tree. All orchestration, skills, and configuration reside in the profile and agent layers.
- **Global Tooling as Canonical Source of Truth**: The installed `page` CLI is the single source of truth for coordination and orchestration. The `coordinate` skill is a thin caller invoking `page coord`.
- **Zero-Downtime Hot Swapping**: When `page update` installs a new engine release, running agent loops detect the new binary between turns and gracefully re-exec without interrupting active Pi turns.
- **Preserve Interactive TUI First**: Support individual terminal windows and tiled workspace grids where the human developer can watch Pi's live thinking, tool calls, and progress in real time, while architecting cleanly for headless/daemon execution in the future.
- **Single GitHub Identity Swarms**: Recognize that all local agents typically authenticate under a single developer GitHub token/PAT (`@charles` or `@Sullux`). Coordination identity must live in the protocol comments (`agent: <callsign>`), never in GitHub's native user-assignee field.

---

## 3. Directory Layout & Workspace Model

The system cleanly separates global engine configuration, profile boundaries, agent identity, project repositories, and instance-specific runtime configurations.

### 3.1 Global & Profile Architecture

```text
~/.config/page/                          # Global engine configuration
├── config.json                          # Engine settings & active profile pointer
├── profiles.json                        # Profile registry (names -> filesystem paths)
└── projects.json                        # Global project registry (aliases -> git remotes)

<profile-root>/                          # Profile root (e.g. ~/agents or /media/ext/work)
├── .page/                               # Engine metadata & profile configuration
│   ├── profile.json                     # Profile defaults (default model, thinking, etc.)
│   └── profile.env                      # Profile-level environment secrets (API keys, tokens)
│
├── .agents/                             # Tooling-discoverable assets
│   └── skills/                          # Skills discoverable by Pi and coding agents
│       └── coordinate/                  # Canonical coordinate skill (invokes page coord)
│
├── alpha/                               # Agent Workspace: Alpha
│   ├── agent.json                       # Agent configuration (model, thinking, compaction)
│   ├── AGENTS.md                        # Agent-level persona & standing guidance
│   ├── projects/                        # Agent × Project configurations (OUTSIDE the repo)
│   │   ├── pp.env                       # Environment variables for 'pp'
│   │   ├── pp.md                        # Standing role guidance for Alpha on 'pp'
│   │   └── pp.json                      # Per-project overrides (optional model/thinking)
│   │
│   ├── pp/                              # Pristine git clone: Pitcairn Portal (alias: pp)
│   └── carma/                           # Pristine git clone: Carma (alias: carma)
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

### 3.2 Clean Separation of `.page` vs. `.agents`
To keep orchestration tooling distinct from agent-discovered capabilities:
1. **`.page/`** is reserved for `page` engine configuration, profile settings, and profile-level secrets (`profile.env`). It is ignored by agent LLM harnesses.
2. **`.agents/skills/`** is structured for automatic framework discovery. The Pi framework traverses upward through parent directories (`..`, `../..`) from the active repository clone looking for `.agents/skills` or `.pi/skills`. Because the profile root hosts `.agents/skills/`, every agent and project clone within that profile automatically discovers the `coordinate` skill with zero repository configuration or symlink pollution.

### 3.3 Strict Project Agnosticism & Per-Agent Clones
Target repositories (`pp`, `carma`) are kept completely pristine:
- **No swarm dependencies**: Projects do not have `@sullux/page` in their `package.json` or committed agent scripts.
- **Dedicated Clones**: Disk space is cheap; developer and agent attention is expensive. Dedicated clones per agent eliminate Git workspace collisions:
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

6. **In-Context Belief Drift vs. Board Reality**:
   - Continuous agent sessions (`pi --continue`) retain turn history, creating inertia where agents hold stale beliefs (e.g., assuming an issue is still "awaiting human ruling" long after the human has ruled).
   - The coordination tool (`coord` / `page coord`) must explicitly highlight state changes in its output (e.g., `[RULED: Ready to claim]`, `[UNBLOCKED]`, `[PR AWAITING REVIEW]`) so the agent's LLM immediately breaks out of stale conversational assumptions.

7. **Decision-to-Task Semantic Lifecycle**:
   - A decision issue awaiting human ruling must carry explicit blocking metadata (`needs-human`, `status:blocked`) so runner pre-flights do not thrash on it.
   - Once ruled on by a human, the issue must cleanly transition in type and title (`decision: ...` -> `task: ...` or `docs: ...`) so that both automated runner filters and LLM semantic parsing recognize it as an actionable, claimable task.

8. **Backlog Discrimination & Visible Cadence**:
   - The runner's pre-flight check must strictly prioritize:
     1. **Owned Active Claims**: If the agent already owns an in-flight issue, proceed immediately (`ready`).
     2. **Actionable Backlog**: If unclaimed tasks (not blocked, not needs-human) or open PRs exist, proceed immediately (`ready`).
     3. **Peer Contention**: If all open issues are held by peers, enter a short backoff (`idle_busy`, 60s) with a visible seconds countdown.
     4. **Drained Queue**: If 0 open issues exist, enter a long backoff (`idle_empty`, 300s) with a visible seconds countdown.
   - Never allow silent, static sleep loops; all waiting cycles must render live in-place countdowns so operators know the loop is healthy and alive.

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

### Hot-Swapping & Zero-Downtime Loop Reloading
When an operator runs `page update` (or `npm i -g @sullux/page`), running agents must pick up the newly installed code seamlessly without crashing or requiring manual restarts:

1. **Subprocess Invocations Are Instantly Hot**:
   Because agents interact with coordination by executing `page coord <cmd>` as a child process from Pi, every coordination command immediately runs the newly installed code on disk.
2. **Supervisor In-Place Re-exec**:
   At the boundary of each loop cycle (during the idle countdown or inter-turn cooldown), the supervisor checks if the on-disk binary mtime or version has changed. If an update is detected, it logs `[page] Update detected: reloading supervisor...` and re-executes itself via `child_process.spawn(process.execPath, process.argv, { stdio: 'inherit' })` before exiting the old process. Active Pi turns finish their turns completely undisturbed.

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

The `page` CLI provides an ergonomic interface for managing profiles, projects, agents, configurations, and running swarms.

### Global Options & Precedence
The active profile is resolved in the following priority:
1. CLI flag: `-p, --profile <name>`
2. Environment variable: `PAGE_PROFILE`
3. Active profile set via `page use <name>`
4. Default fallback: `default` (auto-provisioned at `~/agents`)

```bash
page -p work agents list             # Run command against the 'work' profile
page update                          # Self-update page to the latest version via npm/yarn
```

### Profile Management (`page profiles`, `page use`)
```bash
page profiles list                   # List all registered profiles (marks active with *)
page profiles add <name> <path>      # Register a profile path (initializes .page/ and .agents/)
page profiles remove <name>          # Unregister profile (leaves files intact)
page profiles show [name]            # Show profile details, paths, and environment settings
page use <name>                      # Set the active persistent profile
```

### Project Management (`page projects`)
```bash
page projects add <repo> [--alias <alias>]
                                     # Register a project repository (clones into assigned agents)
page projects list                   # List registered projects and aliases
page projects show <alias>           # Show project details and assigned agents
page projects remove <alias>         # Remove project from registry
```

### Agent Management (`page agents`)
```bash
page agents add <name> [--model <m>] [--thinking <level>]
                                     # Create agent directory, identity AGENTS.md, and configuration
page agents list                     # List all agents in the current profile
page agents show <name>              # Show agent details, active claims, and recent cycles
page agents start <project>          # Start autonomous execution loop for agents on a project
```

### Environment & Guidance Management (`page env`, `page guide`)
```bash
page env edit <agent> <project>      # Open <profile>/<agent>/projects/<project>.env in $EDITOR
page env show <agent> <project>      # Print resolved environment variables for this agent/project
page guide edit <agent> <project>    # Open <profile>/<agent>/projects/<project>.md in $EDITOR
```

### Coordination Tooling (`page coord`)
```bash
page coord sync                      # Synchronize with coordination board and hub
page coord board                     # View open issues by workstream, status, owner, and files
page coord claim <issue> [--plan T]  # Claim an issue with plan and files validation
page coord release <issue> [--reason]# Release an issue claim
page coord status <issue> "text"     # Post heartbeat / status progress update
page coord done <issue> [--pr <url>] # Complete issue and notify dependent issues
page coord hub "text"                # Post high-level sync update to pinned hub issue
```

---

## 9. Stretch Goals & Future Evolution

1. **Multiplexed Monitoring Dashboard (`@sullux/tui`)**:
   - A single-screen terminal console displaying all active agents across projects.
   - Status indicators (idle, working, waiting on PR, error), CPU/memory usage, and current token context percentage.
   - Filterable live streams of thinking and tool invocations across agents.
2. **Daemon Mode**:
   - Background execution with log capture (`page logs <agent> <project> -f`) for truly unattended operation when interactive terminal windows are not needed.
