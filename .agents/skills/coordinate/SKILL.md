---
name: coordinate
description: Multi-agent task coordination for the current repo over GitHub Issues via the gh CLI. Use this whenever you are about to start work in this repository, pick up or hand off a task, split work with a teammate's agent, propose or negotiate an interface between slices or workstreams, report progress, get blocked, or wonder what to work on next - even when the user only says "grab the next thing", "sync up", "what is everyone doing", "post an update", or "file that as a task". Also use it to bootstrap the labels and the pinned coordination hub issue.
---

# Coordinate: multi-agent work over GitHub Issues

Multiple coding agents are editing one repository. GitHub Issues is the one shared memory every agent already has: `gh` is installed, authenticated as its human, and works from any shell. This skill turns Issues into a task board and a negotiation channel with four primitives:

- **Assignment owns responsibility.** An issue with an assignee has one
  accountable owner. `status:in-progress` identifies active work; the Git
  branch and merge conflict remain the code fence.
- **Labels are the state machine.** `status:*`, `ws:*`, `p0`-`p2`,
  `type:*`, `needs-human`.
- **Structured comments are the conversation.** Every protocol comment
  starts with a bold verb (`**CLAIM**`, `**PROPOSE**`, ...) plus who and
  when, so any agent can parse the history with `gh --jq`.
- **Declared invariants are gates.** File scope, contract state, and
  completion criteria remain mandatory when the current helper cannot yet
  enforce them automatically.

Read the active
[v3 playbook](./references/coordination-best-practices-3.md) before
starting work. It supersedes the sprint-era v1 and v2 playbooks.

All commands go through one script so every agent applies the same
rules (label transitions, race checks, stale detection). Run it from
anywhere inside the repo:

```bash
COORD="node .agents/skills/coordinate/scripts/coord.js"
# or backward-compatible shim:
# COORD="bash .agents/skills/coordinate/scripts/coord.sh"
```

## Identity

You act as your human's GitHub account (`gh auth status`). Say which
agent you are so teammates can tell agents apart; set this once per
session before any command:

```bash
export COORD_AGENT="google/gemini-3.8-flash"   # or pi/..., cursor/...
```

## Start of every session

```bash
$COORD sync
```

`sync` prints the board, your open claims, stale claims, anything marked
`needs-human`, and the last few **SYNC** lines from the canonical
*Coordination hub* issue. Bash uses `COORD_HUB` when set and otherwise
selects the lowest-numbered open issue labelled `hub`. PowerShell currently
assumes exactly one open `hub` label. Read it, then post a one-liner:

```bash
$COORD hub "starting #12 (window drag); nothing blocking"
```

Do this before opening files. After session start, reserve `SYNC` for a
cross-stream merge, blocker, freeze, or final state.

## Picking up work

1. Choose an unclaimed issue in your workstream (`ws:*`), highest
   priority first. `p0` is the demo golden path: if a `p0` is
   unclaimed and you can do it, take it over anything else.
2. Claim it with a plan and the current code state. Every claim names a
   branch, PR URL, or `no-code-yet`:

   ```bash
   $COORD claim 12 --plan "branch: feat/window-drag; useDraggable + z-index" --eta 30m
   ```

   If someone else holds it the script refuses; use `propose` to split
   it or `question` to ask. If two agents claim within the same seconds
   the earliest **CLAIM** comment wins and the loser is unassigned
   automatically.
3. Keep exactly one owned issue in `status:in-progress` and at most one in
   `status:blocked`. Other assignments may represent queued responsibility
   and remain `status:claimed`.

No matching issue? Create one; that is how work becomes visible:

```bash
$COORD new "Window drag + z-index" --ws os-shell --p 0 \
  --files "app/features/os/**" \
  --done "title bar drags;click focuses and raises;no negative offsets" \
  --depends "#3"
$COORD claim 12 --plan "no-code-yet; branch will be feat/window-drag" --eta 30m
```

`--files` is mandatory. `board` shows the declared scope so an agent about
to edit `app/shared/contracts.ts` can find overlaps. The current helpers
display scope but do not reject overlap; resolve overlap with a recorded
split or common owner before moving either issue to `in-progress`.

## While working

- Post a **STATUS** at milestones and before 20 minutes of silence:
  `$COORD status 12 "drag works; z-index next"`. In sprint mode, set
  `COORD_STALE_MIN=30`. At 20 minutes without issue, branch, or linked-PR
  activity, post a `QUESTION`; only release at 30 minutes if that ping is
  unanswered. The helper's stale check sees structured issue heartbeats,
  so the caller must inspect Git activity and verify the recorded ping.
- Blocked? Say on what and by whom, then move to something else:
  `$COORD block 12 --by "#7" "need the VFS writeFile signature"`.
  When #7 closes, `done` posts a heads-up on every open issue that
  mentions it.
- Need a human decision (model choice, scope cut, anything from
  `QUESTIONS.md`)? `$COORD question 12 --human "..."` adds
  `needs-human`; humans skim that label.

## Negotiating: interfaces, splits, disputes

Cross-workstream seams are where parallel work collides: the
`install_app` handler (SDE 2) needs the VFS API (SDE 4) and the window
opener (SDE 1). Do not guess a signature. Propose it on a
`type:contract` issue and record the sprint contract as provisional:

```bash
$COORD new "Contract: VFS API used by install_app" --ws persistence --type contract --p 0
$COORD propose 15 --to @m-vawter "writeFile(path,string):Promise<void>; readFile(path):Promise<string|null>; listFiles(dir):Promise<string[]>"
$COORD counter 15 "listFiles should return {path,size}; the launcher needs size"
# full asynchronous mode also requires:
$COORD accept 15 "matches useOsStore hydration"
```

For sprint work, `PROPOSE` must place the exact contract in `## Agreed` as
*provisional* in the same operation. The current helpers post the proposal
but do not write that section, so the proposer must edit the issue body
manually. Agents may proceed inside their own slices. The named seam owner
must acknowledge before a shared adapter merges. One `COUNTER` is allowed;
a further disagreement gets `needs-human`.

For asynchronous or multi-day work, require explicit `ACCEPT` before a
shared contract or adapter merges. `accept` copies the latest proposal into
`## Agreed`. Never treat silence as acceptance.

The same verbs settle ownership: if you want part of a claimed issue,
`propose` the split. Never fork the work silently.

## Finishing

```bash
$COORD review 12 --pr https://github.com/Sullux/pitcairn-portal/pull/9   # PR opened
$COORD done 12 --pr https://github.com/Sullux/pitcairn-portal/pull/9     # PR merged
```

Put `Closes #12` in the PR body so GitHub links it. Before `review`, compare
the PR's changed paths with the union of `## Files` for every linked issue.
Before `done`, verify every `## Done when` box is checked and the supplied
PR is merged. The current helpers do not perform those checks; a successful
command is not evidence that the gates passed.

`done` closes the issue, posts **DONE**, and currently emits compatibility
`DEP-DONE` notices. Then post a final hub line and `sync` again.

## Automation status

| Invariant | Current behavior |
| --- | --- |
| Canonical hub | Bash is deterministic; PowerShell currently requires one open `hub` label |
| Claim file scope | Displayed by `board`; overlap resolution is manual |
| Review file scope | Manual comparison against the union of linked issue scopes |
| Completion | Manual check of criteria and merged PR before `done` |
| Provisional contract | Manual edit of `## Agreed` after `propose` |

The manual rows are protocol requirements and candidates for helper
enforcement. See the
[v3 enforcement rationale](../../../docs/agents/coordination-best-practices-3.md#enforcement-status).

## Commands

| Command | Effect |
| --- | --- |
| `setup` | Create or refresh labels and the pinned hub issue (idempotent; once per repo) |
| `sync` | Board, your claims, stale claims, needs-human, hub tail. The session entry point |
| `board` | Open issues by workstream, status, owner, files |
| `hub "text"` | Post a SYNC one-liner on the hub issue |
| `new "title" --ws X [--p 0-2] [--type task\|contract\|decision\|bug] [--files G] [--done "a;b"] [--depends "#n"] [--body T] [--claim]` | Create an issue from the template |
| `claim N [--plan T] [--eta T]` | Assign yourself; refuses if owned; resolves races |
| `release N [--reason T] [--stale]` | Unassign; `--stale` may release anyone's stale claim |
| `status N "text"` | Heartbeat plus progress; moves claimed to in-progress |
| `block N --by "#m or @user" "text"` / `unblock N "text"` | Mark blocked / unblocked |
| `question N [--to @u] [--human] "text"` / `answer N "text"` | Ask / answer; `--human` adds needs-human |
| `propose N [--to @u] "text"` / `accept N ["text"]` / `counter N "text"` / `reject N "reason"` | Negotiate |
| `handoff N --to @user "text"` | Transfer ownership |
| `review N --pr URL` | Mark in-review after the caller verifies PR scope |
| `done N [--pr URL] ["text"]` | Close after the caller verifies criteria and merge state |
| `stale` | Claims silent longer than `COORD_STALE_MIN` (default 45; sprint 30) |
| `show N` | Print an issue with its structured comment history |

Every verb, its comment format, and the tie-break rules are specified
in [references/protocol.md](references/protocol.md). Read it when you
need to parse comments yourself or hit a case not covered above.

## Working agreements, and why

### Ratified Issue-Dedup Protocol (Standing Rules)

- **Rule A (Signature Pre-File Scan)**: Before filing an issue, scan the board and run `gh issue list --search` for the specific **failure signature** (failing test name, file path, error substring) rather than general title topics. Cite the closest matching issue in the body.
- **Rule B (Twin Resolution Taxonomy)**:
  1. **Subsumed-Empty**: If one PR adds zero net lines vs the other, close with convergent credit + transfer measurements (no empty merges).
  2. **Union-Carry**: If both PRs contribute useful code, the second branch merges the union of both solutions.
  3. **Cede-with-Credit**: If one PR is strictly worse, close it—verifying the surviving PR is still open first.
- **Rule C (Claim Comment Authority)**: Earliest `**CLAIM**` comment timestamp wins ties. Single GitHub accounts use protocol comments as the source of truth, not GitHub assignees.
- **Rule D (Inventory Honesty)**: Coverage and fixme lists must cite live truth so agents do not misdirect work.

### General Invariants

- **Issue before file.** Unclaimed work is invisible work; two agents will
  do it twice. A claim without branch/PR/no-code state is incomplete.
- **Talk in verbs.** Humans can write free text; agents skim by verb.
  The script guarantees the verb line is always there.
- **Record contracts before shared code.** ADR 0001 keeps slices decoupled,
  so the seams between them are exactly where a wrong guess costs an hour.
- **Verify the diff and the finish.** A declared scope and checklist only
  protect the team when review and completion compare them with reality.
- **Escalate early.** `needs-human` is not failure; it is the fastest
  path when two agents lack the context to choose.
- **Read before you write.** `sync` takes ten seconds. A merge
  conflict takes twenty minutes.

## Labels

| Family | Values | Meaning |
| --- | --- | --- |
| `ws:` | `os-shell` `agent-chat` `runtime-engine` `persistence` `integration` `docs` | Workstream (README, Team Workstreams) |
| `status:` | `unclaimed` `claimed` `in-progress` `blocked` `in-review` | Lifecycle; a closed issue is done |
| priority | `p0` `p1` `p2` | `p0` is on the demo golden path |
| `type:` | `task` `contract` `decision` `bug` | Kind of issue |
| flags | `needs-human` `hub` | Escalation; the pinned hub issue |
