const { execFileSync } = require('node:child_process')

// Node's execFileSync caps stdout at maxBuffer (default 1MB) and then THROWS ENOBUFS - it does not
// truncate, the whole call dies. The pitcairn coordination hub (issue #4) crossed that ceiling at
// 1,051,909 bytes / 783 comments and took `page coord board` down for every agent on the box at
// once: viewIssue re-fetches the hub's full timeline, and withFullTimelines exists precisely to ask
// for it. 64MB leaves ~60x headroom over the payload that broke it.
const GH_MAX_BUFFER = 64 * 1024 * 1024

// Named so a pin can assert the fix sits ABOVE the default, not merely that something was passed.
const NODE_DEFAULT_MAX_BUFFER = 1024 * 1024

// Named so a pin can assert the fix sits ABOVE the default, not merely that something was passed.
// #85: `listIssues` asked for 100 rows and nothing compared the reply to that number. gh paginates
// whatever it is handed (measured: `--limit 100|150|300` -> 100|150|300 rows), so 100 was OUR number,
// and the missing tail arrived at the gate as "nobody declared that file" - the one verdict it must
// never guess at. 500 clears today's population (4 open issues in pitcairn, 2 in pi-agents) by two
// orders of magnitude, and hitting it is a loud refusal rather than a silent pass. The neighbour
// lesson is #4's ENOBUFS, which at least THREW: a short list returns status 0 and a plausible board.
const ISSUE_PAGE_CEILING = 500

// #118: a failed kind/state read used to answer `undefined`, and `undefined` is indistinguishable
// from "open" in the only compare its callers write (`kind?.state === 'CLOSED'`). So a `gh` blip
// re-opened exactly the accident #106 closed: pitcairn#1218 measured a `review` verb rc=0 onto an
// issue CLOSED 53 seconds earlier, while `--force` refuses the SAME write. A transport failure is
// therefore not a value any caller may mistake for a payload - it is a thrown, tagged error, the
// same shape `viewPr` above already uses for unparsable JSON.
const KIND_READ_FAILURE = 'coordIssueKindReadFailure'

const kindReadFailure = (number, cause) =>
  Object.assign(
    new Error(
      `coord: the kind/state read for #${number} failed (${String(cause?.message ?? cause)})`,
    ),
    {
      [KIND_READ_FAILURE]: true,
      number,
      reason: String(cause?.message ?? cause),
    },
  )

const isKindReadFailure = (error) => error?.[KIND_READ_FAILURE] === true

const resolveRepoFromRemote = (remoteUrl = '') => {
  const cleaned = remoteUrl.trim().replace(/\.git$/, '')
  const sshMatch = cleaned.match(/github\.com[:/]([^/]+\/[^/]+)/)
  if (sshMatch) return sshMatch[1]
  const httpsMatch = cleaned.match(/https?:\/\/[^/]+\/([^/]+\/[^/]+)/)
  return httpsMatch ? httpsMatch[1] : ''
}

// #41: a repo-less call produced two error lines and everybody read the wrong one. The probe used
// to swallow its own failure and return '', the gh call then went out WITHOUT `--repo`, and Node's
// execFileSync message prints the full argv - so `not a git repository` arrived looking like a
// GitHub or shell-quoting fault, with the entire hub body filling the screen as proof. Measured
// from a directory with no .git: rc=1, nothing posted, and two wrong hypotheses built from that
// text. Both halves are fixed here: the failing probe is named, and a payload never echoes.
const REPO_PROBE = ['remote', 'get-url', 'origin']
const PAYLOAD_FLAGS = ['--body', '--title']

const firstLine = (value) =>
  String(value ?? '')
    .split('\n', 1)[0]
    .trim()

const errorCause = (err) => firstLine(err?.stderr ?? err?.message ?? err)

// Error text only - the spawn always receives the real array.
// Two shapes carry a payload: the space form this client builds today (`--body`, value) and the equals form
// (`--body=value`) that `gh` also accepts. Redacting only the token AFTER a flag would turn a future switch of
// spelling into a silent leak, and the count stays per-value in both forms so the argv remains countable.
const safeArgv = (args = []) =>
  args.map((arg, i) => {
    const inline = PAYLOAD_FLAGS.find((flag) =>
      String(arg).startsWith(`${flag}=`),
    )
    if (inline) {
      const value = String(arg).slice(inline.length + 1)
      return `${inline}=<${value.length} chars redacted>`
    }
    return PAYLOAD_FLAGS.includes(args[i - 1])
      ? `<${String(arg).length} chars redacted>`
      : arg
  })

const GitHubClient = ({
  execFile = execFileSync,
  repo = '',
  cwd = process.cwd(),
} = {}) => {
  // Every source that can name the repo, in precedence order, and the reason each one was or was
  // not usable. GH_REPO counts because `gh` itself reads it: refusing there would break a call the
  // old code completed. The probe result is kept, not discarded, so its failure text is available.
  const resolveRepo = () => {
    if (repo) return { value: repo, why: 'the repo option' }
    if (process.env.COORD_REPO)
      return { value: process.env.COORD_REPO, why: 'COORD_REPO' }
    if (process.env.GH_REPO)
      return { value: process.env.GH_REPO, why: 'GH_REPO' }
    try {
      const remote = execFile('git', REPO_PROBE, {
        cwd,
        encoding: 'utf8',
        maxBuffer: GH_MAX_BUFFER,
      })
      const value = resolveRepoFromRemote(remote)
      if (value) return { value, why: `git ${REPO_PROBE.join(' ')}` }
      return {
        value: '',
        why:
          `git ${REPO_PROBE.join(' ')} answered \`${firstLine(remote) || '(empty)'}\`, ` +
          'which is not a GitHub origin',
      }
    } catch (err) {
      return {
        value: '',
        why: `git ${REPO_PROBE.join(' ')} failed: ${errorCause(err) || 'no message'}`,
      }
    }
  }

  const resolution = resolveRepo()
  const activeRepo = resolution.value

  // Thrown lazily, never at construction: `client.repo` is a display value two callers read
  // (src/cli/index.js's `target`, formatBoard), and an unconstructable client would break a read
  // that may still resolve on its own. By the time this fires nothing has been sent, so the
  // message can promise that honestly instead of leaving it to be inferred from a gh argv dump.
  const noRepoError = () =>
    new Error(
      `coord: no target repo, so nothing was sent to GitHub - ${resolution.why} (cwd ${cwd}). ` +
        'Set COORD_REPO or GH_REPO, pass --repo, or run from inside a repo whose origin is a ' +
        'GitHub remote.',
    )

  // #131 second half: the ceiling refusal named no code, so a message emitted by a process that
  // loaded pre-#111 bytes was indistinguishable from a defect in the current tree, and the fleet
  // argued about that twice before a six-call matrix settled it. Read through the same injected
  // seam as every other external call, and deliberately NOT load-bearing: any answer that is not a
  // hex sha (a fake exec, no git, a tarball) degrades to `unknown` and the refusal still throws
  // with its full axis sentence. Note what the witness can and cannot claim - it names the TREE the
  // process is standing in, not the bytes it loaded at require time; a tree that moved after boot
  // prints a ref newer than its own code, which is why #125's advice note keeps its own wording.
  const codeWitness = () => {
    let ref = 'unknown'
    try {
      const raw = String(
        execFile('git', ['rev-parse', '--short', 'HEAD'], {
          cwd,
          encoding: 'utf8',
          maxBuffer: 64 * 1024,
        }) ?? '',
      ).trim()
      if (/^[0-9a-f]{7,40}$/.test(raw)) ref = raw
    } catch {
      // no git on the box, or an exec double that only answers gh: the witness is decoration
    }
    return ` [code @ ${ref}]`
  }

  const runGh = (args = []) => {
    if (!activeRepo) throw noRepoError()
    const fullArgs = [...args, '--repo', activeRepo]
    let result
    try {
      result = execFile('gh', fullArgs, {
        cwd,
        encoding: 'utf8',
        maxBuffer: GH_MAX_BUFFER,
      })
    } catch (err) {
      // Node's own text is `Command failed: gh <whole argv>`; that argv is where a 3KB hub line
      // used to land, and a body on screen reads like the body was the problem.
      throw new Error(
        `coord: gh ${args.slice(0, 2).join(' ')} failed against ${activeRepo} - ` +
          `${errorCause(err) || 'no message'}\n  argv: gh ${safeArgv(fullArgs).join(' ')}`,
      )
    }
    return result?.toString()?.trim() || ''
  }

  // #30: GitHub numbers issues and pull requests in ONE sequence, and `gh issue view` answers a PR
  // number with a PR's data (a pull request IS an issue in the API), so a coord verb could stamp a
  // protocol comment and a status label onto a merged PR - measured twice on pitcairn (a **REVIEW**
  // landing on PR #1138 while issue #1136 got nothing; a second one re-opening merged PR #1110).
  // The kind is NOT available from `gh issue view --json`: measured `Unknown JSON field:
  // "pull_request"` and `"isPullRequest"` at f34349b. It lives on the raw API object, where the
  // `pull_request` key exists exactly for PRs - so this goes through `gh api`, which is also the one
  // gh subcommand that refuses `--repo` (measured: `unknown flag: --repo` + the whole help text),
  // hence a separate spawn that carries the resolved slug in the endpoint path instead.
  // #57: this is the second path to `gh`, and `runGh`'s guard did not cover it - `gh api` rejects `--repo`
  // (measured: `unknown flag: --repo`), so the slug lives in the endpoint, and with no repo resolved that
  // endpoint was `repos//issues/N`: still spawned, still answered `gh: Not Found (HTTP 404)` on the terminal,
  // right under a message promising that nothing was sent. The promise has to hold about reads as well as
  // writes, or #41 is only half fixed.
  const ghApi = async (endpoint, jq) => {
    if (!activeRepo) throw noRepoError()
    const result = execFile('gh', ['api', endpoint, '--jq', jq], {
      cwd,
      encoding: 'utf8',
      maxBuffer: GH_MAX_BUFFER,
    })
    return result?.toString()?.trim() || ''
  }

  // #126: `gh api` (REST) answers `closed` while `gh issue view --json state` (GraphQL) answers
  // `CLOSED`, and the one consumer of this method - `refuseIfNotOpen` in `src/coord/index.js` -
  // compares `kind?.state === 'CLOSED'`. Measured at `4eccb91`: `issueKind(94)` returned
  // `{"isPullRequest":false,"state":"closed","stateReason":"completed"}` and the guard answered "not
  // an issue-shaped problem" on a CLOSED target, which is how foxtrot's REVIEW (6759789295) and STATUS
  // (6759802769) are sitting on closed pi#94 right now with rc 0. Normalized here rather than at the
  // compare, because this method is the thing that mis-stated its own contract; every consumer then
  // inherits a working check.
  //
  // SUPERSEDED for the failed-read half by #118, which landed in this same file: the sentence below
  // used to read "`undefined` on a failed read is deliberately UNCHANGED", and it is the plan this
  // branch executed instead of honored - a failed read now THROWS (module-level `kindReadFailure`,
  // defined above the client factory), and the 31 doubles that "would redden" were re-pinned onto
  // `state: 'OPEN'` rather than
  // left relying on the silence. Kept as history because the casing rule above is still live and a
  // reader needs to know why the two blocks in this function disagree about `undefined`: widening a
  // signal falsifies the prose written about the old signal, so the correction travels with it.
  const upper = (value) =>
    typeof value === 'string' ? value.toUpperCase() : value

  // #118: TWO failures, deliberately separated. A transport error or unparsable stdout THROWS
  // (see `kindReadFailure`); an object that genuinely carries no `state` answers with `state:
  // undefined` and is still readable. Callers must now opt into the healthy case by name, because
  // the old `catch { return undefined }` made the broken read look like the healthy one.
  const issueKind = async (number) => {
    let payload
    try {
      payload = await ghApi(
        `repos/${activeRepo}/issues/${number}`,
        '{isPullRequest: (.pull_request != null), state: .state, stateReason: .state_reason, title, body}',
      )
    } catch (error) {
      throw kindReadFailure(number, error)
    }
    let kind
    try {
      kind = JSON.parse(payload)
    } catch (error) {
      throw kindReadFailure(number, error)
    }
    return {
      ...kind,
      state: upper(kind.state),
      stateReason: upper(kind.stateReason),
    }
  }

  // #123 is blocked on exactly this read: to tell "nobody attested anything" from "the ticks live in
  // the closing PR's body", it needs the issue's own timeline, and `viewIssue` returns only
  // body/comments/labels/number/title. Bounded per CALL, not per sweep - the caller caps how many
  // issues it asks about (`MAX_CLOSURE_LINES`), which is how #110's rule survives: pitcairn holds
  // 1236 closed issues against `ISSUE_PAGE_CEILING = 500`, so enumerating the closed population to
  // find a closing PR is a truncated read that would report itself as a result. Pagination stays
  // inside one issue, and events are FLATTENED rather than filtered per page, because
  // `gh api --paginate -q '.[-1]'` evaluates its filter on every page and returns page one's tail -
  // the recorded false-negative this method must not reintroduce.
  const TIMELINE_EVENT_CEILING = 2000

  const issueTimeline = async (number) => {
    if (!activeRepo) throw noRepoError()
    const result = execFile(
      'gh',
      [
        'api',
        `repos/${activeRepo}/issues/${number}/timeline`,
        '--paginate',
        '--jq',
        '.[]',
      ],
      { cwd, encoding: 'utf8', maxBuffer: GH_MAX_BUFFER },
    )
    const text = result?.toString()?.trim() || ''
    if (!text) return []
    const lines = text.split('\n')
    if (lines.length > TIMELINE_EVENT_CEILING)
      throw new Error(
        `issueTimeline(#${number}) returned ${lines.length} events, above the ${TIMELINE_EVENT_CEILING} per-issue ceiling. This read is meant to be bounded by the caller's flagged-row count, not to stream a hub; refusing rather than truncating, because a short timeline is a confident wrong answer about what evidence exists.`,
      )
    // One unparseable line means the stream was not what we asked for (a half-written page, or a jq
    // shape that emitted scalars). Returning [] there would read as "this closure has no evidence",
    // which is the exact false sentence #123 exists to stop the sweep printing.
    return lines.map((line, index) => {
      try {
        return JSON.parse(line)
      } catch {
        throw new Error(
          `issueTimeline(#${number}) event ${index + 1} of ${lines.length} is not JSON (${line.slice(0, 80)}) - refusing to read a malformed timeline as an empty one.`,
        )
      }
    })
  }

  const listIssues = async (options = {}) => {
    const state = options.state || 'open'
    // #113: `|| ISSUE_PAGE_CEILING` read an explicit 0 as "not given", and the at-cap guard below compares the reply
    // length to THIS number - so limit 0 fell through to 500 and then refused at exactly 500, telling the caller to
    // pass a larger options.limit, which is the value it had already passed. gh rejects --limit 0 outright (measured:
    // it errors and returns no rows), so a 0 in the argv is never the failure; the reinterpretation is here. null and
    // undefined keep meaning "use the ceiling" because that is what preflight's CLOSE_SCAN_LIMIT passes on purpose.
    if (
      options.limit !== undefined &&
      options.limit !== null &&
      !(Number.isInteger(options.limit) && options.limit > 0)
    ) {
      throw new Error(
        `coord: gh issue list was given options.limit = ${JSON.stringify(options.limit)}, which is not a positive ` +
          `integer. 0 is not "unlimited" on this box (gh rejects --limit 0), and the at-cap guard compares the number ` +
          `of rows to this value, so a 0 would read as truncation on an empty page. Pass a positive integer, or omit ` +
          `options.limit (or pass null) to use the ceiling (${ISSUE_PAGE_CEILING}). Nothing was run.`,
      )
    }
    const limit = options.limit ?? ISSUE_PAGE_CEILING
    const argv = [
      'issue',
      'list',
      '--state',
      state,
      '--limit',
      String(limit),
      '--json',
      'number,title,labels,comments,body,closedAt',
    ]
    // #107: --limit cannot say "the last six hours", and asking for a smaller number is not a
    // smaller read when the population exceeds the ceiling either way - the rows past the cap are
    // simply invisible. A caller that can name a server-side predicate now has a way to pass one.
    // ABSENT, never empty: gh treats --search "" as a predicate matching nothing, so forwarding an
    // empty option would silently narrow the very set this client guards - the false-negative
    // direction, where a claim that should collide is waved through.
    const search = options.search
    if (search !== undefined && search !== '') argv.push('--search', search)
    const raw = runGh(argv)
    // The old `catch { return [] }` was the bug, not the guard. Four degraded shapes all landed in it
    // and each one emptied the collision set: empty stdout, an `<html>Server Error</html>` body,
    // truncated JSON, and - reachable with no catastrophe at all - one `warning:` line printed above
    // valid JSON, because `runGh` only throws on a nonzero exit and the parse then fails on the blob.
    // A caller handed `[]` cannot tell "the open set is empty" from "the read failed" on ANY axis, and
    // `listLabels` below already states the rule this site broke: an unreadable read is UNKNOWN, not absent.
    const text = String(raw ?? '').trim()
    // #135: this refusal accused the OPEN set and the scope gate whatever `state` was asked for, so a
    // closed or all read that got garbage back from gh told the operator about a set it never touched -
    // the mis-attribution #131/#134 removed from the at-cap arm below, at its sibling site. Measured
    // 12/12 cells at b4a725d (3 axes x 4 degraded shapes) before this change: no axis token, no witness.
    // Each cost is stated in the terms of the caller that can actually reach it: the gate for `open`,
    // the closure sweep for `closed`, both for anything else - so `all` names the split and asks for one.
    const axisCost =
      state === 'open'
        ? 'The open-issue set is UNKNOWN, not empty: a silent [] here empties the scope gate and lets ' +
          'every claim through, so this refuses instead.'
        : state === 'closed'
          ? 'The closed-issue set is UNKNOWN, not empty: a silent [] here hands the unattested-closure ' +
            'sweep a confident zero over a read that failed, so it must read UNKNOWN and not clean, ' +
            'and this refuses instead.'
          : `The ${String(state).toUpperCase()}-issue set is UNKNOWN, not empty: state:'${state}' spans ` +
            'BOTH axes, so a silent [] would empty the claim gate and read a failed closure sweep as ' +
            "zero unattested at once. Retry on ONE axis ('open' or 'closed'); this refuses instead."
    // This site is reached by three different callers depending on the axis: the claim gate asks for
    // `open`, the closure sweep for `closed`, and a state:'all' read for both - so the actor has to be
    // derived from the axis here rather than hardcoded, or one of the three is being lied about.
    const siteOne =
      state === 'open'
        ? ['the claim gate', 'a target issue against the live collision set']
        : state === 'closed'
          ? ['the unattested-closure sweep', 'zero unattested at this repo']
          : ['a state:all reader', 'either axis on its own']
    const unreadable = (detail, actor, target) =>
      new Error(
        `coord: gh issue list returned unreadable output for ${activeRepo || 'the resolved repo'} on the ${state} axis - ${detail}. ` +
          `Caller: ${actor}, which cannot check ${target}. ` +
          axisCost +
          codeWitness(),
      )
    if (!text.startsWith('[')) {
      throw unreadable(
        text
          ? `readout is not JSON: starts with ${JSON.stringify(text.slice(0, 2))} across ${text.length} bytes`
          : 'empty stdout',
        siteOne[0],
        siteOne[1],
      )
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      throw unreadable(
        `JSON parse failed (${errorCause(err)}) after ${text.length} bytes`,
        'the unattested-closure sweep',
        'its carrier issue',
      )
    }
    if (!Array.isArray(parsed))
      throw unreadable(
        `parsed a ${typeof parsed}, not an array`,
        `the caller asking for state:${state}`,
        'its list read',
      )
    // Exactly-at-cap is the only truncation signal a list can give, so it is treated as one and named
    // with its remedy. Below the cap the set is complete and says nothing - tagging every call would
    // cry wolf the way the `withFullTimelines` header warns about for the comment axis.
    if (parsed.length === limit) {
      // #111: the remedies and the collision maxim are OPEN-axis advice. A closure sweep has no collision set,
      // and #107's own rationale is that a bigger constant is "the same cliff with a longer runway" - so the
      // closed arm offers only the bound that works there and states the stakes of a sweep, not of a claim gate.
      const repoName = activeRepo || 'the resolved repo'
      const lead = `coord: gh issue list returned exactly ${limit} issues on the ${state} axis for ${repoName}, `
      // #113: the closed arm told every operator to "pass options.search" - and the one caller that can ever reach
      // this refusal (preflight's unattested-closure sweep) always passes that predicate, so the sentence advised a
      // completed action and hid the two knobs still in play. Name the bound the call actually used when there is
      // one; keep the advice when there is not. A per-call options.limit is offered on BOTH arms because it is not
      // the shared ceiling constant #111 correctly removed: measured on pitcairn, the same 90-day window refuses at
      // 500 and returns 558 rows at 1000.
      const boundedSearch =
        typeof options.search === 'string' && options.search.trim()
          ? options.search.trim()
          : ''
      const sweepStakes =
        ' An unreadable sweep reads as UNKNOWN, which is honest; a confident zero off a truncated page is not.'
      // #131 first half: this split was `open` vs `not open`, so a `state:'all'` read - which gh
      // accepts, and which a census uses - printed its own lead as `on the all axis` and then had
      // the tail accuse the CLOSED set and advise a `closed:>=` predicate for a set that is not
      // closed-only. Measured live at 1fbea98 across a six-call matrix. `all` gets its own arm: it
      // names the axis that was asked for, tells the operator to pick ONE axis first, and keeps the
      // bound/tighten/raise-per-call remedies that work on either axis. #111's negative blocks still
      // hold on it: no ISSUE_PAGE_CEILING, no `missed collision`, no `scope gate`.
      const boundNote = boundedSearch
        ? `The read already carries a server-side bound (${boundedSearch}), so the knobs left are a tighter window and a larger options.limit (per-call, not the shared ceiling).`
        : 'Bound it server-side (options.search, e.g. closed:>=<UTC date> or is:issue), narrow the window, or pass a larger options.limit (per-call, not the shared ceiling).'
      const openArm =
        lead +
        'so the OPEN set is TRUNCATED and the tail is invisible to the scope gate - raise ' +
        `ISSUE_PAGE_CEILING (currently ${ISSUE_PAGE_CEILING}) or pass a larger options.limit. ` +
        'A missed collision is worse than a refused claim.'
      const closedArm =
        lead +
        `so the CLOSED set is TRUNCATED and this read cannot be swept at all. ${boundNote}` +
        sweepStakes
      const unboundedClosedArm =
        lead +
        'so the CLOSED set is TRUNCATED and this read cannot be swept at all - bound it server-side ' +
        '(pass options.search, e.g. closed:>=<UTC date>), narrow the window, or pass a larger ' +
        'options.limit (per-call, not the shared ceiling).' +
        sweepStakes
      const bothAxesArm =
        lead +
        `so the ${String(state).toUpperCase()} set is TRUNCATED and this read cannot be swept at all - ` +
        `state:'${state}' spans BOTH axes, so pick one (state:'open' or 'closed') before bounding it. ` +
        boundNote +
        sweepStakes
      throw new Error(
        (state === 'open'
          ? openArm
          : boundedSearch
            ? state === 'closed'
              ? closedArm
              : bothAxesArm
            : state === 'closed'
              ? unboundedClosedArm
              : bothAxesArm) + codeWitness(),
      )
    }
    return parsed
  }

  // #53 review ask: the hub refusal advised `label one issue 'hub'` in repos whose taxonomy has no
  // `hub` label at all, where `gh issue edit --add-label hub` dies with `could not add label` and
  // creates nothing - advice GitHub refuses in the exact repo where the message fires. To advise the
  // exit that WORKS, the refusal has to know the taxonomy. Deliberately throws on a failed read
  // rather than returning []: an unreadable taxonomy is UNKNOWN, not absent, and the caller says so.
  const listLabels = async () => {
    const raw = runGh(['label', 'list', '--json', 'name'])
    return JSON.parse(raw)
      .map((l) => (typeof l === 'string' ? l : l?.name))
      .filter((n) => typeof n === 'string')
  }

  const viewIssue = async (number) => {
    const raw = runGh([
      'issue',
      'view',
      String(number),
      '--json',
      'number,title,labels,comments,body',
    ])
    try {
      return JSON.parse(raw)
    } catch {
      return undefined
    }
  }

  const commentIssue = async (number, body) =>
    runGh(['issue', 'comment', String(number), '--body', body])

  // #87: `coord review --pr` has to put the verdict where it is read, which is the PR
  // thread. This is NOT a reuse of commentIssue above: `gh issue comment` refuses a
  // pull-request number, so the verb itself differs. Same argv shape on purpose - the
  // body travels as an argument, never as `-` (which posts the literal two-character
  // body) and never as `@file` (only -F expands that).
  const commentPr = async (number, body) =>
    runGh(['pr', 'comment', String(number), '--body', body])

  // #89: `review --pr` has to attest WHICH commit it reviewed, because the consumer this repo
  // already has - src/runner/preflight.js's isPrReviewedByAgent - matches a PR comment only
  // when the short head SHA appears in its body. It reads ONE pull request instead of reusing
  // listPrs below on purpose: preflight legitimately needs the whole list, a verdict needs one
  // number, and listPrs carries every PR's comments with it. A null field yields '', which the
  // caller turns into a reported warning rather than a silently unsigned verdict.
  const viewPr = async (number) => {
    const raw = runGh(['pr', 'view', String(number), '--json', 'headRefOid'])
    try {
      return JSON.parse(raw).headRefOid || ''
    } catch (error) {
      throw new Error(
        `coord: gh pr view #${number} returned unparsable JSON (${String(
          error?.message || error,
        )})`,
      )
    }
  }

  const editIssue = async (
    number,
    { addLabels = [], removeLabels = [] } = {},
  ) => {
    const args = ['issue', 'edit', String(number)]
    if (addLabels.length) args.push('--add-label', addLabels.join(','))
    if (removeLabels.length) args.push('--remove-label', removeLabels.join(','))
    return runGh(args)
  }

  const closeIssue = async (number) => runGh(['issue', 'close', String(number)])

  const createIssue = async ({ title, body, labels = [] }) => {
    const args = ['issue', 'create', '--title', title, '--body', body]
    if (labels.length) args.push('--label', labels.join(','))
    return runGh(args)
  }

  const listPrs = async (options = {}) => {
    const state = options.state || 'open'
    const raw = runGh([
      'pr',
      'list',
      '--state',
      state,
      '--json',
      'number,title,labels,headRefName,headRefOid,state,comments,closingIssuesReferences',
    ])
    try {
      return JSON.parse(raw)
    } catch {
      return []
    }
  }

  return {
    repo: activeRepo,
    runGh,
    issueKind,
    issueTimeline,
    listIssues,
    listLabels,
    viewIssue,
    commentIssue,
    commentPr,
    viewPr,
    editIssue,
    closeIssue,
    createIssue,
    listPrs,
  }
}

module.exports = {
  resolveRepoFromRemote,
  GitHubClient,
  kindReadFailure,
  isKindReadFailure,
  KIND_READ_FAILURE,
  GH_MAX_BUFFER,
  NODE_DEFAULT_MAX_BUFFER,
  ISSUE_PAGE_CEILING,
}
