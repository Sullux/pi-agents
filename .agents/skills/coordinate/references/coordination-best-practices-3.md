---
type: playbook
title: Coordination Best Practices v3
description: An evidence-calibrated GitHub Issues protocol.
tags: [agents, coordination, process, retrospective, evidence]
status: active
---

# Coordination best practices v3

## Verdict

**Judgment:** Keep GitHub Issues as the shared ledger, but make the ledger
describe reality instead of asking agents to perform ceremony. Assignment,
declared files, structured comments, and independent review paid for
themselves. Silent auto-accept, unchecked completion criteria, unrestricted
hub updates, and assignment-as-WIP did not. For the next sprint, enforce file
and completion invariants in the script, distinguish responsibility from
active work, and make every claim name its branch or say that no code exists.

## Enforcement status

V3 makes three invariants normative. Passing a helper command does not yet
prove all three: canonical hub selection is automated, while scope and
completion require a manual preflight until the helpers implement the same
gates.

| Invariant | Protocol requirement | Current helper status |
| --- | --- | --- |
| Canonical hub | Keep one `hub`; Bash uses `COORD_HUB` or the lowest-numbered open hub | Bash automated |
| File scope | Claim a non-empty scope; resolve active overlap; PR paths must be within the union of linked issue scopes | Required; manual at claim and review |
| Completion | Every `Done when` box is checked and the linked PR is merged | Required; manual before `done` |

The wire protocol records these as MUST-level checks. The helpers' current
limitations are tracked as automation work, not exceptions to the rules.

## Rules for the next sprint

### 1. Assignment owns responsibility; state marks active work — change

Keep assignment as the universally visible owner. Stop treating the number
of assignments as active WIP: peak open assignments per login ranged from one
to five because the board also assigned queued responsibilities.

- Put exactly one owned issue in `status:in-progress` per login.
- Allow one additional `status:blocked` issue. Leave queued responsibility in
  `status:claimed`; do not collapse `claimed` and `in-progress`.
- In every `CLAIM`, include `branch: <name>`, `pr: <URL>`, or `no-code-yet`.
- Treat the Git branch and merge conflict as the fence. A release transfers
  attention; it cannot make another branch disappear.

This keeps v2's WIP intent while making it measurable.

### 2. Declare files, then verify the diff — keep and enforce

Keep `## Files`; it had complete adoption and helped detect overlap. Add two
checks:

1. Refuse a claim whose scope overlaps an open in-progress claim until the
   issue records a split or common owner.
2. At `review`, compare the PR's changed paths with the union of `## Files`
   on every linked issue. Refuse or warn on undeclared paths.

Do not let a convenience PR become an integration bucket. If one PR closes
several issues, its body must list each issue and the union of their scopes.

### 3. Record seams before shared code; do not accept by silence — change

- Name one seam owner in the contract issue.
- Make `PROPOSE` atomically write the exact provisional contract under
  `## Agreed`; never rely on a later edit.
- Let agents proceed inside their own slices, but require the seam owner to
  acknowledge the shared adapter before it merges.
- If implementation changes the contract, update `Agreed` in the same PR.
- Permit one `COUNTER`, then escalate. Do not add negotiation rounds.

### 4. Ping, then release — keep with instrumentation

Keep the sprint ladder: ping after 20 minutes with no visible activity, then
allow release after 10 more minutes without an answer. Count issue comments,
linked-PR pushes, and branch updates as activity. For work outside GitHub,
such as video production, the owner must post a brief `STATUS` inside the
20-minute ceiling.

Never release without a recorded ping.

### 5. Ship single-purpose PRs; distribute review and merge — change

Replace “tiny PR” with “one purpose and one declared file union.” Line counts
are a poor boundary when scaffolds and lockfiles are large.

- Request an independent review as soon as the PR opens.
- Let any eligible non-author merge after required checks and approvals; do
  not queue every merge behind the repository owner.
- If policy requires two approvals, request both immediately and surface the
  second-review queue as one dashboard, not repeated `SYNC` messages.
- Freeze new features early enough to leave one full review-and-rebase cycle.

Do not remove independent review. It caught failures that would have broken
the golden path.

### 6. Route every summary to one canonical hub — keep and enforce

A status dashboard temporarily shared the `hub` label with the original
coordination hub. Deterministic routing prevented split-brain writes, but the
label should identify one issue, not a class of summaries.

- If `COORD_HUB` is set, route to that issue.
- Otherwise, route to the lowest-numbered open issue labelled `hub`.
- Keep exactly one canonical issue labelled `hub`; use a distinct dashboard
  marker for editable status summaries.
- Restrict `SYNC` to session start, cross-stream merge, blocker, freeze, and
  final state.

## Protocol surface

| Keep | Use |
| --- | --- |
| `CLAIM` | Establish owner, declared scope, and branch/PR/no-code state |
| `STATUS` | Record a milestone or satisfy the activity lease |
| `BLOCKED` | Name the dependency and required action |
| `QUESTION` / `ANSWER` | Drive human escalation and clear `needs-human` |
| `PROPOSE` / `COUNTER` | Record one seam decision round |
| `HANDOFF` | Transfer responsibility with context |
| `DONE` | Close only after merged PR and verified acceptance criteria |
| `RELEASE` | Return responsibility after handoff or stale ladder |
| `SYNC` | Session start, cross-stream merge, blocker, freeze, final state |

Drop `DEP-DONE`; it generated 16 notices against only three `UNBLOCKED`
comments. Let the board derive dependency state. Drop protocol `REVIEW`
comments after the issue stores its PR URL; GitHub already records reviews.
Fold `UNBLOCKED` into `STATUS`. Keep `ACCEPT` only in asynchronous full mode.

Make `DONE` a real gate: refuse it while a `Done when` box is unchecked or
the linked PR is unmerged. Do not auto-check criteria merely because CI is
green; the caller must attest or update each criterion.
