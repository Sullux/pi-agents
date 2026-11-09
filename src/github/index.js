const { execFileSync } = require('node:child_process')

// Node's execFileSync caps stdout at maxBuffer (default 1MB) and then THROWS ENOBUFS - it does not
// truncate, the whole call dies. The pitcairn coordination hub (issue #4) crossed that ceiling at
// 1,051,909 bytes / 783 comments and took `page coord board` down for every agent on the box at
// once: viewIssue re-fetches the hub's full timeline, and withFullTimelines exists precisely to ask
// for it. 64MB leaves ~60x headroom over the payload that broke it.
const GH_MAX_BUFFER = 64 * 1024 * 1024

// Named so a pin can assert the fix sits ABOVE the default, not merely that something was passed.
const NODE_DEFAULT_MAX_BUFFER = 1024 * 1024

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

  // Returns `{ isPullRequest, title, body }` for the number, or `undefined` when gh errors or the
  // payload will not parse - an unresolvable number is NOT reported as a pull request, because the
  // verbs already fail loudly on their own read of it and this guard's job is only to stop a write
  // that would land on the wrong kind of artifact.
  const issueKind = async (number) => {
    try {
      return JSON.parse(
        await ghApi(
          `repos/${activeRepo}/issues/${number}`,
          '{isPullRequest: (.pull_request != null), title, body}',
        ),
      )
    } catch {
      return undefined
    }
  }

  const listIssues = async (options = {}) => {
    const state = options.state || 'open'
    const limit = options.limit || 100
    const raw = runGh([
      'issue',
      'list',
      '--state',
      state,
      '--limit',
      String(limit),
      '--json',
      'number,title,labels,comments,body',
    ])
    try {
      return JSON.parse(raw)
    } catch {
      return []
    }
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
    listIssues,
    listLabels,
    viewIssue,
    commentIssue,
    editIssue,
    closeIssue,
    createIssue,
    listPrs,
  }
}

module.exports = {
  resolveRepoFromRemote,
  GitHubClient,
  GH_MAX_BUFFER,
  NODE_DEFAULT_MAX_BUFFER,
}
