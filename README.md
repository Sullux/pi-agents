# @sullux/page

> Autonomous multi-agent development orchestration for the **Pi Framework** and **GitHub Issues**.

`page` packages the multi-agent swarming pattern developed during high-velocity collaborative development sprints. It enables teams of autonomous coding agents to collaborate concurrently on complex software repositories without central locks, human micro-management, or loss of auditability.

---

## Core Philosophy

- **GitHub Issues as Shared Decentralized Memory**: Issues serve as work orders, structured protocol comments (`**CLAIM**`, `**RELEASE**`, `**DONE**`) form an immutable state machine, and Git branches/PRs provide hard code fences.
- **Pi Framework Execution Harness**: Interactive TUI, rich tool use, model-driven reasoning, inspectable session logs, and auto-compaction extensions.
- **Strict Project Agnosticism**: Target repositories remain completely clean and unaware of `page`. No framework dependencies in `package.json`, and no swarm-specific tooling committed into project trees.
- **Physical Workspace Isolation & Profiles**: Workspaces are cleanly partitioned into profiles (`personal`, `work`), each with its own filesystem root, credentials, and dedicated per-agent git clones.
- **Hot-Swapping**: When running `page update`, active supervisors detect the new binary between turns and gracefully re-exec without interrupting active agent sessions.

---

## Quick Start

### 1. Installation

Install globally via `npm` or `yarn`:

```bash
npm install -g @sullux/page
# or
yarn global add @sullux/page
```

### 2. Configure a Profile

Profiles keep personal projects and client/work repositories cleanly partitioned with their own API keys and workspace roots:

```bash
# Register your primary workspace directory
page profiles add personal ~/agents

# Set as default active profile
page use personal
```

On first run, if no profile exists, `page` will offer to initialize a default profile at `~/agents`.

### 3. Register Agents

Add one or more agents to the active profile:

```bash
page agents add Alpha --model anthropic:claude-3-5-sonnet-latest --thinking low
page agents add Bravo --model anthropic:claude-3-5-sonnet-latest --thinking low
page agents add Charlie --model anthropic:claude-3-5-sonnet-latest --thinking low
```

### 4. Enroll a Project

Register a GitHub repository with an optional short alias:

```bash
page projects add Sullux/pitcairn-portal --alias pp
```

`page` automatically provisions dedicated clones for your agents and sets up project templates outside the git trees.

### 5. Launch Agents in Terminals

The workflow is human-centric: open a terminal window for each agent you want working concurrently and start them independently:

```bash
# Terminal 1:
page start Alpha pp

# Terminal 2:
page start Bravo pp

# Terminal 3 (with initial steering):
page start Charlie pp --steering "Prioritize ws:admin-portal issues"
```

Each terminal runs Pi in interactive TUI mode with live thinking and diffs. During inter-cycle cooldowns or backlog waits, press **`q`** or **`Esc`** to cleanly stop the loop.

To check on active agents from another terminal:
```bash
page status
# or filter by project:
page status pp
```

To stop an agent remotely:
```bash
page stop Alpha
```

### 6. Keep It Updated

Upgrade to the latest engine release at any time:

```bash
page update
```

Running agent supervisors pick up the new engine release automatically at their next turn boundary.

---

## CLI Reference

### Global Options

```bash
page --help                          # Show command help
page --version                       # Show current version
page -p, --profile <name>            # Run command under a specific profile
page update                          # Upgrade page to the latest release
```

### Session Management (`page start`, `page status`, `page stop`)

```bash
page start <agent> <project>         # Start single autonomous agent session in this terminal
page start <agent> <project> --steering "..." # Start with initial operator guidance
page status [project]                # Display table of active sessions (PID, status, uptime)
page stop <agent> [--kill]           # Stop an active agent session remotely (SIGTERM/SIGKILL)
```

### Profile Management (`page profiles`, `page use`)

```bash
page profiles list                   # List all registered profiles (* marks active)
page profiles add <name> <path>      # Register a profile root directory
page profiles show [name]            # Inspect profile paths, settings, and secrets
page profiles remove <name>          # Unregister profile (leaves files intact)
page use <name>                      # Switch persistent active profile
```

### Project Management (`page projects`)

```bash
page projects list                   # List enrolled projects
page projects add <repo> [--alias A] # Enroll a GitHub repo
page projects show <alias>           # Show project details and agent clones
page projects remove <alias>         # Unenroll project from active profile
```

### Agent Management (`page agents`)

```bash
page agents list                     # List agents in active profile
page agents add <name> [--model M]   # Create a new agent
page agents show <name>              # Show agent details and active claims
```

### Environment & Guidance (`page env`, `page guide`)

```bash
page env show <agent> <project>      # Print resolved 4-tier environment variables
page env edit <agent> <project>      # Edit instance-level environment in $EDITOR
page guide edit <agent> <project>    # Edit standing role instructions in $EDITOR
```

### Coordination Protocol (`page coord`)

```bash
page coord board                     # View open issues by status, owner, and files
page coord sync                      # View board, your claims, stale items, and hub tail
page coord claim <issue> [--plan P]  # Claim an issue (enforces scope non-collision)
page coord release <issue>           # Release active claim
page coord status <issue> "text"     # Post heartbeat progress update
page coord done <issue> [--pr N]     # Complete issue and mark done
page coord hub "text"                # Post high-level sync to coordination hub
```

---

## Architecture

For an in-depth breakdown of the 4-tier configuration matrix, autonomous execution loop, single-account protocol tie-breakers, and directory layout, see [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## License

This project is licensed under the [MIT License](./LICENSE).

---

## Disclaimer

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
