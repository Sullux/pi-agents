# Coordination protocol v2

The wire format and invariants behind `coord.sh`. Any agent
with `gh` can follow it by hand. The scripts standardize comments and state
transitions, but command success does not waive a manual invariant.

The active operating guidance is
[coordination best practices v3](./coordination-best-practices-3.md).

## Comment header

Every protocol comment begins with one header line, then a blank line,
then a free-form body:

```text
**VERB** | agent: <agent-id> | human: @<login> | at: <ISO-8601 UTC>

<body>
```

- `agent-id` follows the OKF actor convention (`claude-code/<model>`,
  `pi/<version>`, `human` when typed by a person).
- Parse with `select(.body | startswith("**CLAIM**"))` in `gh --jq`.
- Header lines are ASCII so they survive every terminal encoding.
- Treat the API comment author as the canonical human identity and the API
  `createdAt` as canonical time. The typed `human:` and `at:` fields are
  advisory because heterogeneous clients can emit malformed values.

## Verbs

| Verb | Active use | Side effects | Body should contain |
| --- | --- | --- | --- |
| `CLAIM` | Core | Assign self; `status:claimed` | Plan plus `branch:`, `pr:`, or `no-code-yet` |
| `RELEASE` | Core | Unassign; `status:unclaimed` | Reason; stale releases cite the unanswered ping |
| `STATUS` | Core | `status:claimed` becomes `in-progress` | Milestone, next step, or unblock context |
| `BLOCKED` | Core | `status:blocked` | `by:` `#n` or `@user`, and the required action |
| `QUESTION` | Core | `needs-human` if `--human` | Question and `to:` |
| `ANSWER` | Core | Removes `needs-human` | Answer |
| `PROPOSE` | Core | Sprint: provisional `## Agreed` is also required | One exact interface and `to:` |
| `COUNTER` | Core | Further disagreement requires `needs-human` | One revised proposal |
| `HANDOFF` | Core | Reassign; `status:claimed` | `to:`, branch, PR, validation, stop, next action |
| `DONE` | Core | Close; current helper also emits `DEP-DONE` | Merged `pr:` and summary |
| `SYNC` | Core | Canonical hub only | Session start, cross-stream merge, blocker, freeze, or final state |
| `ACCEPT` | Full async only | Proposal appended to `## Agreed` | Explicit acknowledgment |
| `UNBLOCKED` | Compatibility | `status:in-progress` | Use `STATUS` with what changed |
| `REVIEW` | Compatibility | `status:in-review` | Prefer linked PR state after scope preflight |
| `DEP-DONE` | Compatibility | None | Derive dependency state from the board |
| `REJECT` | Compatibility | None | Prefer one `COUNTER`, then escalate |

The active heartbeat verbs are `CLAIM`, `STATUS`, and `HANDOFF`. Current
helpers also recognize `UNBLOCKED` for backward compatibility.

## Required invariants

These are MUST-level protocol gates. The enforcement table says whether the
current helpers verify them or whether the caller must do so manually.

### Responsibility and active work

1. Assignment identifies the accountable owner.
2. Each login has exactly one owned issue in `status:in-progress` and at
   most one in `status:blocked`. Queued responsibility stays
   `status:claimed`.
3. Every `CLAIM` records a branch name, PR URL, or `no-code-yet`. The branch
   and merge conflict are the code fence; release only transfers attention.

### File scope

1. `## Files` is non-empty before claim.
2. A claim that overlaps an open `status:in-progress` claim waits until the
   issue records a split or common owner.
3. Before `review`, collect every issue linked by the PR. Every changed path
   must match the union of those issues' `## Files` globs.
4. A PR closing several issues lists every issue and represents one purpose
   within the declared union.

### Contracts

For sprint work, `PROPOSE` writes the exact interface into `## Agreed` as
*provisional*. Agents may work inside their own slices, but the named seam
owner acknowledges before shared adapter code merges. One `COUNTER` is
allowed before `needs-human`. Silence never accepts a contract.

For asynchronous or multi-day work, explicit `ACCEPT` is required before a
shared contract or adapter merges.

### Completion

`DONE` is valid only when every `## Done when` checkbox is checked and the
supplied PR URL resolves to a merged PR. CI cannot attest product criteria
by itself, and callers must not auto-check criteria merely because CI is
green.

### Canonical hub

`COORD_HUB`, when set, names the canonical hub. Otherwise the
lowest-numbered open issue labelled `hub` is canonical. Exactly one issue
should retain that label; an editable dashboard uses a separate marker.
`SYNC` comments go only to the canonical hub and only for the bounded events
listed in the verb table.

### Enforcement status

| Invariant | Shell / PowerShell helpers |
| --- | --- |
| Canonical hub selection | Bash enforces `COORD_HUB`/lowest; PowerShell requires one open `hub` label |
| Non-empty and non-overlapping claim scope | Manual; `board` exposes scopes but claim does not reject |
| PR diff within linked issue-scope union | Manual before `review` |
| Checked criteria and merged PR | Manual before `done` |
| Provisional contract written by `PROPOSE` | Manual issue-body edit |

A helper exit code of zero establishes only the scripted side effects. It
does not establish a manual invariant.

## Tie-breaks and edge cases

1. **Claim race.** Among the current assignees, the author of the
   earliest `CLAIM` comment keeps the issue. The script checks two
   seconds after assigning and backs the loser off with a `RELEASE`.
2. **Stale claim.** In sprint mode, ping at 20 minutes without visible
   issue, branch, or linked-PR activity. Set `COORD_STALE_MIN=30`, and use
   `release N --stale` only after the ping remains unanswered for 10 more
   minutes. The helper checks structured issue heartbeats only; the caller
   verifies Git activity and the ping. Multi-day work uses a six-hour
   warning plus three-hour grace during active workdays.
3. **Negotiation cap.** Active sprint protocol permits one `COUNTER`, then
   adds `needs-human`. Current helpers automatically escalate on the fourth
   `PROPOSE`/`COUNTER` for compatibility, so agents must stop earlier.
4. **Who decides `needs-human`.** The humans of the agents involved.
   If they are unavailable, the repo owner (`@xcjs`) decides.
5. **File overlap.** Responsibility for a path follows the active issue
   whose `## Files` globs match it. When two active scopes overlap, the
   later claimant records a split or common owner before proceeding.
6. **Dependencies.** Write `#n` under `## Depends on` in the body. Current
   helpers emit `DEP-DONE` notices, but active protocol derives dependency
   state from the board and records the result with `STATUS`.
7. **Hub issue.** `COORD_HUB` wins when set; otherwise the lowest-numbered
   open issue labelled `hub` wins. Keep only that issue labelled `hub` and
   reserve it for bounded `SYNC` comments. If none exists, `setup` creates
   and pins one.

## Issue body template

```markdown
## Goal
<one paragraph>

## Done when
- [ ] <observable criterion>

## Files
<non-empty globs this issue will touch>

## Code state
<branch: name | pr: URL | no-code-yet>

## Depends on
#n

## Notes
_(created by <agent> for @<login> at <time>)_

## Agreed
_(contracts only: exact interface, provisional/accepted state, seam owner)_
```

Current `new` commands generate the common subset. The claimant adds code
state in `CLAIM`; a contract proposer adds `## Agreed` manually until the
helpers make that update atomic.

## Parsing examples

Last heartbeat on an issue:

```bash
gh issue view 12 --json comments \
  --jq '[.comments[] | select(.body|test("^\\*\\*(CLAIM|STATUS|HANDOFF)\\*\\*")) | .createdAt] | max'
```

All open proposals on a contract issue:

```bash
gh issue view 15 --json comments \
  --jq '.comments[] | select(.body|startswith("**PROPOSE**") or startswith("**COUNTER**")) | "\(.createdAt) \(.author.login)\n\(.body)\n"'
```

Everything assigned to you:

```bash
gh issue list --assignee @me --state open --json number,title,labels \
  --jq '.[] | "#\(.number) \(.title) [\([.labels[].name]|join(","))]"'
```

## For agents that cannot run bash

Follow the table above with raw `gh` commands. A claim, by hand:

```bash
gh issue comment N --body "$(printf '**CLAIM** | agent: pi/1 | human: @you | at: %s\n\nplan: no-code-yet; ...' "$(date -u +%FT%TZ)")"
gh issue edit N --add-assignee @me --add-label status:claimed --remove-label status:unclaimed
```

The same claim in PowerShell 5.1 (watch out: inline `--jq` filters
with parentheses mangle in double quotes — prefer plain `--json`
output and `ConvertFrom-Json`):

```powershell
$hdr = '**CLAIM** | agent: pi/1 | human: @you | at: ' + `
  (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
gh issue comment N --body "$hdr`n`nplan: no-code-yet; ..."
gh issue edit N --add-assignee @me --add-label status:claimed --remove-label status:unclaimed
```

The labels, header line, and required invariants are the contract; the
script is a convenience.
