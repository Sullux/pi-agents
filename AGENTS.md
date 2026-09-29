## Coding Style

- Vanilla JavaScript only: no TypeScript, minimal dependencies, minimal build steps (or minimal copy/paste)
  - Note: Astro is a reasonable build step and is acceptable for websites.
  - Note: If using Astro and dynamic server-side content is required, HTMX is the preferred client-side dynamic rendering library.
  - Note: Do not add dependencies for libraries that do simple jobs. Better to write our own implementation for e.g. ULIDs, loggers, etc. Only add dependencies where absolutely necessary.
- Code must be auditable and readable: all dependencies visible, no transpilation
- Functional programming style: factories over classes, const over let, comprehensions over loops, ternary over branching (except performance-critical DB ops)
- No classes, no `this`
- Code style is prettier.js but ADD trailing commas and REMOVE semicolons (see .prettierrc for details)
  - `.prettierrc` pins `printWidth: 120` to match the codebase (measured p99 = 156) - do not "fix" it to 80
  - Run `npx prettier --write` on files YOU touch only - never a whole-repo sweep mid-wave (half the repo predates the pin; a full reformat is a coordinated quiet-hour task, tracked in #219)
- Use CJS for backend, MJS for frontend.
- Use Node.js built-in testing framework instead of a 3rd-party framework
- Use `yarn` instead of `npm` (assume yarn is already globally installed)
- Naming: Always PascalCase (factories), SHOUT_CASE (app-level or module-level constants) or camelCase (everything else)
  - GOOD: `const bucketPrefix = foo` (camelCase variable)
  - GOOD: `const BucketDb = (config) => {...}` (PascalCase factory)
  - BAD: `const bucket_prefix = foo` (snake_case variable)
  - BAD: `function BucketDB (config) {...}` (Function statement instead of expression and bad `DB` instead of good `Db`)
- Reference imports without extensions e.g. `require('./foo')` instead of `require('./foo.js')`
- Bias towards shorter code files no longer than 100 lines
  - Make exceptions where reasonable e.g. a translation layer full of simple A -> B mapping functions is not reasonable to split up
  - When a code file is too long, convert to a folder with an `index.js` importing multiple sub-files e.g. `foo.js` becomes `foo/index.js`, `foo/bar.js` and `foo/baz.js` so as not to break existing imports (because `require(./foo)` still works before and after)
  - **A folder conversion MUST delete the old `foo.js`** - Node resolves `require('./foo')` to `foo.js` OVER `foo/index.js`, so leaving the old file in place shadows the entire new folder and the conversion silently changes nothing (measured in #148/#149). `mv foo.js foo/index.js` then split.
  - Do not artificially reduce line count by e.g. putting multiple declarations on one line.
  - Do reduce line count by refactoring into multiple files without sacrificing readability.

ALWAYS use dependency injection for non-deterministic dependencies. Example:

```javascript
// BAD
const Widget = (x, y) => ({
  x,
  y,
  timestamp: Date.now(),
})

// GOOD
const Widget = (now) => (x, y) => ({
  x,
  y,
  timestamp: now(),
})

// inject runtime dependencies in index.js:
const { Widget } = require('./widget')
module.exports = {
  Widget: Widget(Date.now),
}

// mock dependencies in widget.test.js
const { Widget } = require('./widget')
const mockWidget = Widget(() => 1)(42, 42)
assert(mockWidget.timestamp === 1)
```

## Memories

- Uncommitted edits die to `git reset --hard`/`git checkout --` (lost twice this way) - commit memory edits immediately, never batch them with a reset.
- `coord claim N` can falsely report "already yours" when ANOTHER agent holds the claim (all agents share the `@Sullux` account) - ALWAYS verify ownership via the issue's `**CLAIM** | agent:` comments before writing code; a false claim report caused a 3-way PR pileup on #238 (foxtrot claimed 12:16, bravo + delta both "claimed" later and built full duplicates).
- Never `git add -A`/`git commit -A` in multi-agent worktrees: an ignored `node_modules` symlink got tracked and broke every checkout (#314/#317/#318); add explicit paths only, and verify with `git ls-tree`, never by checkout thrashing.
- GitHub blocks `--approve` on the shared account ("Can not approve your own pull request" - every PR is "own") - post review verdicts as `gh pr comment`; `gh pr merge` works fine.
- Push-vs-merge race (3 occurrences): a fix pushed to a PR branch VANISHES if the merge lands first - after every merge, fetch and grep the fixed marker on origin/main (#349's reason); "fix pushed - pull before merge" or merge only on explicit "branch final".
- Branch names are shared mutable state: never re-use a branch name for a re-attempt (suffix `-2`), and delete the remote branch when a task closes without merging - a stale same-name push lands as contextless "new work" (#333).
- Rebase conflict polarity: `git checkout --theirs` mid-rebase takes YOUR COMMIT's version ("ours" = the branch being rebased ONTO). To match upstream byte-for-byte use `git checkout origin/main -- <file>`, and verify with `git diff origin/main -- <file>`.
- Branching from anything but origin/main drags the old branch's commits into the new PR (the Files gate caught the #355 commit inside #360) - `git checkout -b new origin/main`, then cherry-pick; verify with `git log --oneline origin/main..HEAD` before pushing.
- Security codes need `crypto.randomInt`, never `Math.random` - even in shared long-shipped services (OtpService generated OTPs with Math.random until #357 froze Math.random in a pin and proved the codes predictable).
- The coordination board is a LOSSY projection of the comment timeline: when board and comments disagree, COMMENTS win - scan for `**CLAIM**` comments without matching RELEASEs from the same agent before picking up anything the board calls unclaimed (two backed-off non-claims in one night on #395/#402 saved by this check).
- Usage-line prose can masquerade as subcommands: `coord.sh hub on "text"` posted the literal word `on` and dropped every real hub update for a whole session (#387) because `hub on|blocked|next` in the help text read like a verb - verify invocation shapes against the PARSER's actual positional arity, not the usage prose.
- A PR's head branch can be missing from the remote while the PR stays open (two in one night reachable only via `refs/pull/N/head`, `gh pr checkout` failing) - merge works off the pull ref but refresh/checkout workflows break; the deleted-branch-on-open-PR class is behind #333's contextless pushes.
- A count mismatch is a verification FAILURE, not noise: the 136-vs-138 e2e delta caught a stale `origin/main` fetch before it produced a wrong post-merge verdict - when the numbers disagree with your expectation, stop and re-fetch before believing either.
- Judge a teammate's branch from the LIVE ref, never a cached fetch: a stale pr-539 ref showed a fixed site still broken and I drafted a fix-forward for code that was already correct (the push was rejected non-fast-forward before any damage - the push-vs-merge class in a reviewer's hat).
- A failed `git pull` must FAIL the measurement: a "tip green" run silently measured a stale tree because the pull errored while the pipeline continued (the failed command must gate every claim that follows it).
- A discrimination probe that does not LAND measures nothing: an edit that fails to change the code (a first-occurrence replace hitting a comment, a reverted probe that never applied) yields a vacuous green/red pair - verify the probe's marker in the code before trusting its verdict.
