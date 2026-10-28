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

const GitHubClient = ({
  execFile = execFileSync,
  repo = '',
  cwd = process.cwd(),
} = {}) => {
  const getRepo = () => {
    if (repo) return repo
    if (process.env.COORD_REPO) return process.env.COORD_REPO
    try {
      const remote = execFile('git', ['remote', 'get-url', 'origin'], {
        cwd,
        encoding: 'utf8',
        maxBuffer: GH_MAX_BUFFER,
      })
      return resolveRepoFromRemote(remote)
    } catch {
      return ''
    }
  }

  const activeRepo = getRepo()

  const runGh = (args = []) => {
    const fullArgs = activeRepo ? [...args, '--repo', activeRepo] : args
    const result = execFile('gh', fullArgs, {
      cwd,
      encoding: 'utf8',
      maxBuffer: GH_MAX_BUFFER,
    })
    return result?.toString()?.trim() || ''
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
    listIssues,
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
