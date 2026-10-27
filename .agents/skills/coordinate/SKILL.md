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

All commands go through ONE tool so every agent applies the same
rules (label transitions, race checks, scope gates).

**Authoritative implementation** (#816): the `page` package, invoked as
`page coord <verb>`. Resolve its real location with
`readlink -f $(which page)` before citing a path - the checkout differs per
machine, and a path hardcoded in a seeded file rots. Version `0.1.0`; the
scope gate needs commit `4edf471` or later. The entries under this skill's
`scripts/` are shims onto it:

```bash
COORD="node {{COORD_SKILL_DIR}}/scripts/coord.js"
# both are provisioned from pi-agents' tracked .agents/skills/coordinate/scripts/
# coord.js  spawns `page coord` and PROPAGATES its exit status - a refused claim,
#           a scope collision or a typo'd verb must not read as success (#816)
# coord.sh  execs coord.js
```

Use an ABSOLUTE path. The relative form this file used to document
(`node .agents/skills/coordinate/scripts/coord.js`) does not resolve from
inside a project worktree - measured `MODULE_NOT_FOUND` from an agent's
`<agents-root>/<name>/pp` worktree - and that is how an agent ends up running
whatever copy it finds instead.

**Non-authoritative copy in circulation**: a 647-line bash `coord.sh`, md5
`b20ca1e954e783fe3771180092108ca7`, seen at `/tmp/coord.sh` and
`/tmp/coordinate-skill-backup/scripts/coord.sh` (the original lives in the
Dominic project). Do NOT run it, and do not report its behaviour as the
fleet's: it has no scope gate, no claim race, no stale detection, and its
`files_of` word-tokenizes, so it refuses claims over English function words.
Verify which implementation you are invoking before trusting any gate
verdict - `readlink -f $(which page)`.

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

For a long or markdown body, use a file rather than a shell string - quoting
fails and the body gets truncated long before the API does:

```bash
$COORD hub --body-file /tmp/sync.md      # body from a file
$COORD hub --body "text"                  # explicit text
$COORD hub --body-file /tmp/x.md "p.s."   # BOTH are kept, joined by a blank line
```

Every source is concatenated, so no part of a message can be dropped quietly.
The refusal contract: if the resolved text is empty or whitespace-only, or a
flag is given without a value, `hub` exits **1**, prints the usage line, and
posts **nothing** - it never reports `Posted to hub` for a contentless update.
A leading bare subverb is stripped first (`on`, `blocked`, `next`), so
`hub on "text"` posts `text` while `hub on` alone is refused.

The emitted comment is shape-classifiable on its first line, matching `claim`,
`status`, `review` and `done`:

```text
**SYNC** | agent: agent-<name> | human: @<human> | at: <epoch milliseconds>
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
| Canonical hub | `COORD_HUB` when set, else the lowest-numbered open issue labelled `hub` |
| Claim file scope | Enforced on `claim`: `parseScope` reads the issue's `## Files`, `checkScopeCollision` refuses a real overlap and exits 1 |
| Review file scope | Manual comparison against the union of linked issue scopes |
| Completion | Manual check of criteria and merged PR before `done` |
| Provisional contract | Manual edit of `## Agreed` after `propose` |

The manual rows are protocol requirements and candidates for helper
enforcement. See the
[v3 enforcement rationale](references/coordination-best-practices-3.md#enforcement-status).

## Commands

| Command | Effect |
| --- | --- |
| `setup` | Create or refresh labels and the pinned hub issue (idempotent; once per repo) |
| `sync` | Board, your claims, stale claims, needs-human, hub tail. The session entry point |
| `board` | Open issues by workstream, status, owner, files |
| `hub "text"` / `hub --body "text"` / `hub --body-file <path>` | Post a **SYNC** line on the hub issue; exits 1 and posts nothing if the resolved text is empty |
| `new "title" --ws X [--p 0-2] [--type task\|contract\|decision\|bug] [--files G] [--done "a;b"] [--depends "#n"] [--body T] [--claim]` | Create an issue from the template |
| `claim N [--plan T] [--eta T]` | Assign yourself; refuses if owned; resolves races |
| `release N [--reason T] [--stale]` | Unassign; `--stale` may release anyone's stale claim |
| `status N "text"` | Heartbeat plus progress. Does NOT move `claimed` to `in-progress`; transition with `gh issue edit N --add-label status:in-progress` |
| `block N --by "#m or @user" "text"` / `unblock N "text"` | Mark blocked / unblocked |
| `question N [--to @u] [--human] "text"` / `answer N "text"` | Ask / answer; `--human` adds needs-human |
| `propose N [--to @u] "text"` / `accept N ["text"]` / `counter N "text"` / `reject N "reason"` | Negotiate |
| `handoff N --to @user "text"` | Transfer ownership |
| `review N --pr N` | Mark in-review after the caller verifies PR scope. `--pr` takes the PR NUMBER (rendered `pr: #N`), not a URL |
| `done N [--pr URL] ["text"]` | Close after the caller verifies criteria and merge state |
| `stale` | Claims silent longer than `COORD_STALE_MIN` (default 45; sprint 30) |
| `show N` | Print an issue with its structured comment history |

Every verb, its comment format, and the tie-break rules are specified
in [references/protocol.md](references/protocol.md). Read it when you
need to parse comments yourself or hit a case not covered above.

### Verbs that do NOT exist in the authoritative tool

`page coord` implements exactly eight verbs (`src/cli/index.js`): `board`,
`sync`, `hub`, `claim`, `release`, `status`, `review`, `done`. Every other
row in the table above falls through to `printHelp()` and exits 1 - it does
not exist and it does not warn, so the issue silently never moves. Read from
the parser, not from prose in this file: help text like
`coord.sh hub on|blocked|next "text"` made a whole session post the literal
word `on` as its hub update (#387).

| Documented but missing | Substitute |
| --- | --- |
| `new`, `setup` | `gh issue create`, `gh issue edit` with the labels below |
| `block`, `unblock`, `question`, `answer` | `gh issue comment` + `gh issue edit --add-label` |
| `propose`, `accept`, `counter`, `reject`, `handoff` | `gh issue comment` in the protocol's comment format |
| `show`, `stale` | `gh issue view N --json body,comments,labels,assignees` |

### Scope-gate behaviour worth knowing before you trust a refusal

- `parseScope` matches `## Files` only at the START OF A LINE and skips
  fenced code blocks (#816). Before that fix an issue documenting the Files
  section parsed its own prose as scope and lost its real paths (measured on
  #816 itself: 14 prose entries, 0 paths), and a fenced example contributed
  its example path plus the closing fence. Both are pinned in
  `pi-agents/test/coord/coord.test.js`.
- Comparison is whole-line set intersection, so prose inside a `## Files`
  section cannot fabricate a collision. A refusal citing English function
  words (`on: the,the,for,the`) came from the non-authoritative bash copy.
- The gate SKIPS issues you already claim, by design: the owner cannot
  collide with itself. The consequence is asymmetric - annotate your own
  Files section with prose and you can make an unrelated issue unclaimable
  for everyone else while never seeing the error, because the only agent
  exempted from the check is the one who caused it. Keep `## Files`
  prose-free; put narrowing notes under their own heading.
- An H3 subsection inside `## Files` does NOT close the section: its heading
  line is dropped, but every other line under it is read as a path. Close
  the section with an H2 (`## Notes`) instead of a subheading.
- Scope entries are NORMALIZED before comparison (pi-agents `4edf471`):
  list bullets and backticks are stripped, and `;`-joined declarations split
  into one path each. So `- \`src/a.js\`` and `src/a.js;test/b.spec.js` do
  collide with a bare `src/a.js`, as they always should have. A trailing
  prose clause is still NOT stripped (`src/a.js - the route` stays one token
  and will not collide), so declare bare paths, one per line, and put
  commentary in another section.
- The refusal names EVERY colliding file, not just the first - one shared
  file can look incidental when two are actually in conflict.

- Why this mattered: #820 declared `- \`post.astro\``-style bullets while
  in-flight #770 declared `post.astro;test/e2e/resident.spec.js` on one
  line. The gate returned `hasCollision:false` on a pair sharing TWO files,
  while #820's own body told the claimer to expect a `split:` refusal.
  Measured across all 18 live claims: 1 collision detected before the fix,
  5 after, and all 4 newly-found ones were real.

#### Status-aware collisions and the `split:` escape (#863, measured 2026-10-27)

The gate used to treat every open issue alike, so work that was FINISHED
fenced work that had not started. Measured 2026-10-26: 5 of 5 unclaimed
issues were unclaimable, 4 of them frozen by an issue merely sitting in
review. Re-measured 2026-10-27: #820, the board's only unclaimed issue,
still refused against in-review #786 on two paths. Current semantics:

| Overlapping issue's status | Effect |
| --- | --- |
| `status:in-review` | WARNS - the claim succeeds, you owe a rebase after it merges |
| `status:claimed`, `status:in-progress`, `status:blocked` | REFUSES - those are live edits |
| no status label, or `status:unclaimed`, but owned | REFUSES |
| owned by YOU | skipped entirely, as before |

A warning is not silent: `claim` prints one line per overlap and the CLAIM
comment carries a `scope:` note, so a teammate reading the timeline knows
your branch owes a rebase.

**Recording a split.** A line-anchored `split: #N` (or `split: #N,#M`) in
EITHER body waives the collision between exactly that pair and no other -
put it on its own line, in the other issue's body or your own. This is the
remedy the bash variant always documented and pitcairn #831 already carries
in the wild; the canonical gate honours it as of this change. Two cautions:

- A `split:` line is an AGREEMENT, never a path. It is filtered out of scope
  parsing, so #831's live line no longer masquerades as a declared file.
- A FENCED `split:` example grants no waiver, so documenting the syntax in
  an issue body is safe.

A hard refusal now names the blocking issue's status and the escape, e.g.
`... held by delta (src/a.js) - blocking issue is status:in-progress; a
line-anchored 'split: #820' in either body waives the pair`. Read the status
before reacting: `in-progress` means negotiate or wait, and if it names an
issue whose PR has already merged, the label is stale - `gh pr view` before
you trust it.

**The board marks an unparseable scope loudly.** An issue whose Files heading
is an H3, or whose section is prose-only, parses to ZERO entries: `claim`
refuses it with `declares no Files scope` while the board used to print `-`,
the same cell an absent `ws:`/`p` label gets. pitcairn #769 rendered as free
and refused at claim time - two surfaces disagreeing about one fact. Such a
row now prints `!!NO-SCOPE`. If you see it, the issue needs its heading fixed
to a line-start `## Files` before anyone can claim it.

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

## Seeding and provisioning (#865)

This file is the tracked SEED that `profile.js` copies into every newly
provisioned workspace, so it is written to be machine-independent:

- Paths derivable from the provisioning target are written as a mustache
  token naming the skill directory, which `ensureProfileStructure`
  substitutes with that workspace's own absolute skill directory at copy
  time - so the token appears in the seed only and never in an installed
  copy. They stay ABSOLUTE because #816 measured the relative form failing
  from inside a project worktree.
- Machine-level paths (the pi-agents checkout) are deliberately NOT
  hardcoded. Resolve them at runtime with `readlink -f $(which page)`.
- `references/` is provisioned alongside this file, so both
  `references/...` links above resolve in a fresh workspace.

Do not "fix" this file by copying an installed workspace's SKILL.md back
over it: that re-hardcodes one box's absolute paths into every future
workspace, which is the defect #816 exists to prevent. Drift runs one way -
seed to install - and the install copy is only written when absent, so an
edit made here reaches NEW workspaces and never existing ones.
