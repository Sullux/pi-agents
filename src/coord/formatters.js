const { ownerOf, cleanAgent, protocolStatus } = require('./owner')
const { parseScope, labelNames, statusOf } = require('./scope')

// #15: `labelNames` (scope.js) tolerates BOTH shapes a caller can hand us - gh's object labels
// (`{ name }`) and a normalized string list - and the gate (`statusOf`) already reads through it.
// The formatters read `l.name` directly, so normalizing labels first produced a coordination gate
// that worked and a board that threw `TypeError: Cannot read properties of undefined (reading
// 'startsWith')` at the status site. The worse half is silent: the `hub` filter compares
// `l.name === 'hub'`, which cannot throw and therefore keeps the hub issue, rendering it as a board
// row - visible only once the crash is fixed. One accessor for both modules, all six sites.
const hasLabel = (issue, name) => labelNames(issue).includes(name)

const labelValue = (issue, prefix, fallback = '-') =>
  labelNames(issue)
    .find((name) => name?.startsWith(prefix))
    ?.slice(prefix.length) || fallback

const priorityLabel = (issue) =>
  labelNames(issue).find((name) => /^p\d$/.test(name || '')) || '-'

const pad = (str = '', len = 0) =>
  str.length >= len ? str : str + ' '.repeat(len - str.length)

// #863: a 0-entry scope used to render as `-`, the same cell an absent ws/p label gets, so an
// issue whose Files heading was an H3 (pitcairn #769) looked FREE on the board while `claim`
// refused it with "declares no Files scope". Two surfaces disagreed about the same fact. Keep the
// parse strict and make the board loud instead, so the unclaimable issue is visible before an
// agent spends a claim attempt discovering it.
const scopeCell = (body) => parseScope(body).join(' ') || '!!NO-SCOPE'

// #66: does this issue carry ANY status label? If it does, that label is the whole truth for the
// cell and nothing below runs, so a repo that labels its issues (pitcairn) cannot shift by one
// byte. If it does not, `statusOf`'s `|| 'unclaimed'` fallback is not a measurement - it is the
// absence of one - and the CLAIM timeline is the only evidence left.
const hasStatusLabel = (issue) =>
  labelNames(issue).some((name) => name?.startsWith('status:'))

// #66: the timeline can only ever say held / free / review, while labels carry finer states
// (`in-progress`, `blocked`) that all mean held. Comparing the raw strings would call an
// `in-progress` issue with a CLAIM a contradiction, which it is not - only a real reversal is.
const STATUS_COARSE = {
  claimed: 'held',
  'in-progress': 'held',
  blocked: 'held',
  todo: 'free',
  unclaimed: 'free',
  'in-review': 'review',
  merged: 'done',
}

const coarseStatus = (name) => STATUS_COARSE[name] || name

const statusCell = (issue) => {
  if (hasStatusLabel(issue)) return statusOf(issue)
  return protocolStatus(issue) || statusOf(issue)
}

const formatBoard = (issues = [], currentAgent = '', repo = '') => {
  const cleanCurrent = cleanAgent(currentAgent)
  const nonHubIssues = issues.filter((i) => !hasLabel(i, 'hub'))

  const lines = [
    '== board ==',
    'ISSUE  STATUS       WS              P   OWNER                       TITLE                                        FILES',
  ]

  for (const issue of nonHubIssues) {
    const owner = ownerOf(issue)
    const statusLabel = statusCell(issue)
    const wsLabel = labelValue(issue, 'ws:')
    const pLabel = priorityLabel(issue)
    const files = scopeCell(issue.body)
    const ownerDisplay = owner
      ? owner === cleanCurrent
        ? `*${owner}*`
        : owner
      : '-'

    lines.push(
      `${pad(`#${issue.number}`, 6)} ` +
        `${pad(statusLabel, 12)} ` +
        `${pad(wsLabel, 15)} ` +
        `${pad(pLabel, 3)} ` +
        `${pad(ownerDisplay, 27)} ` +
        `${pad(issue.title, 44)} ` +
        `${files}`,
    )
  }

  const truncated = nonHubIssues.filter((i) => i.commentsTruncated)
  if (truncated.length) {
    lines.push(
      `!! ${truncated.map((i) => `#${i.number}`).join(', ')}: gh returned only the first 100 comments, so the OWNER above may be stale`,
    )
  }

  // #66: a derived cell is a weaker claim than a labelled one, so say where it came from instead
  // of letting "claimed" read as if a human had set it. Only rows with NO status label appear here.
  const derived = nonHubIssues.filter(
    (i) => !hasStatusLabel(i) && protocolStatus(i),
  )
  if (derived.length) {
    lines.push(
      `!! ${derived.map((i) => `#${i.number}`).join(', ')}: ${repo || 'this repo'} carries no status:* label on these issues, so STATUS is derived from their protocol timeline (CLAIM/HANDOFF/RELEASE/DONE/REVIEW) - not a human-set status`,
    )
  }

  // #66, the #46/#44 face: the label write failed while the comment landed, so the two surfaces of
  // ONE fact point opposite ways. The label still wins in the cell (callers read it) and the board
  // names the reversal rather than contradicting its own OWNER column in silence.
  const disputed = nonHubIssues.filter((i) => {
    if (!hasStatusLabel(i)) return false
    const fromTimeline = protocolStatus(i)
    return (
      Boolean(fromTimeline) &&
      coarseStatus(fromTimeline) !== coarseStatus(statusOf(i))
    )
  })
  if (disputed.length) {
    lines.push(
      `!! ${disputed.map((i) => `#${i.number} label='${statusOf(i)}' timeline='${protocolStatus(i)}'`).join(', ')} - the label and the CLAIM comments disagree, which is #46's shape (the comment is the record)`,
    )
  }

  return lines.join('\n')
}

const formatSync = ({
  issues = [],
  currentAgent = '',
  repo = '',
  hubNumber = 4,
  staleMinutes = 45,
  now = Date.now(),
} = {}) => {
  const cleanCurrent = cleanAgent(currentAgent)
  const boardSection = formatBoard(issues, currentAgent, repo)

  // 1. Yours
  const yourIssues = issues.filter((i) => ownerOf(i) === cleanCurrent)
  const yourLines = [
    `\n== yours (${cleanCurrent || 'unspecified'}) ==`,
    yourIssues.length
      ? yourIssues
          .map((i) => `  #${i.number} ${i.title} (${scopeCell(i.body)})`)
          .join('\n')
      : '  (none)',
  ]

  // 2. Stale claims
  const staleCutoff = now - staleMinutes * 60 * 1000
  const staleIssues = issues.filter((i) => {
    const owner = ownerOf(i)
    if (!owner) return false
    const lastClaim = (i.comments || [])
      .filter((c) => c.body?.trim().startsWith('**CLAIM**'))
      .pop()
    if (!lastClaim?.createdAt) return false
    return new Date(lastClaim.createdAt).getTime() < staleCutoff
  })

  const staleLines = [
    `\n== stale claims (> ${staleMinutes}m) ==`,
    staleIssues.length
      ? staleIssues
          .map((i) => `  #${i.number} (${ownerOf(i)}): ${i.title}`)
          .join('\n')
      : '  (none)',
  ]

  // 3. Needs-human
  const needsHuman = issues.filter((i) => hasLabel(i, 'needs-human'))
  const humanLines = [
    '\n== needs-human ==',
    needsHuman.length
      ? needsHuman.map((i) => `  #${i.number}: ${i.title}`).join('\n')
      : '  (none)',
  ]

  // 4. Hub tail
  const hubIssue = issues.find(
    (i) => i.number === hubNumber || hasLabel(i, 'hub'),
  )
  const hubComments = (hubIssue?.comments || []).slice(-5)
  const hubLines = [
    `\n== hub #${hubIssue?.number || hubNumber}, last 5 comments ==`,
    hubComments.length
      ? hubComments.map((c) => `  ${c.body}`).join('\n\n')
      : '  (none)',
    ...(hubIssue?.commentsTruncated
      ? [
          "  !! gh returned only the first 100 comments, so the tail above is the FIRST page's, not the latest - read the hub with `gh issue view` before trusting it",
        ]
      : []),
  ]

  return [
    boardSection,
    ...yourLines,
    ...staleLines,
    ...humanLines,
    ...hubLines,
  ].join('\n')
}

module.exports = {
  formatBoard,
  formatSync,
  pad,
}
