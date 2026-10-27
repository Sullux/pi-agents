const { ownerOf, cleanAgent } = require('./owner')
const { parseScope } = require('./scope')

const pad = (str = '', len = 0) =>
  str.length >= len ? str : str + ' '.repeat(len - str.length)

// #863: a 0-entry scope used to render as `-`, the same cell an absent ws/p label gets, so an
// issue whose Files heading was an H3 (pitcairn #769) looked FREE on the board while `claim`
// refused it with "declares no Files scope". Two surfaces disagreed about the same fact. Keep the
// parse strict and make the board loud instead, so the unclaimable issue is visible before an
// agent spends a claim attempt discovering it.
const scopeCell = (body) => parseScope(body).join(' ') || '!!NO-SCOPE'

const formatBoard = (issues = [], currentAgent = '') => {
  const cleanCurrent = cleanAgent(currentAgent)
  const nonHubIssues = issues.filter(
    (i) => !i.labels?.some((l) => l.name === 'hub'),
  )

  const lines = [
    '== board ==',
    'ISSUE  STATUS       WS              P   OWNER                       TITLE                                        FILES',
  ]

  for (const issue of nonHubIssues) {
    const owner = ownerOf(issue)
    const statusLabel =
      issue.labels
        ?.find((l) => l.name.startsWith('status:'))
        ?.name.replace('status:', '') || 'unclaimed'
    const wsLabel =
      issue.labels
        ?.find((l) => l.name.startsWith('ws:'))
        ?.name.replace('ws:', '') || '-'
    const pLabel = issue.labels?.find((l) => l.name.match(/^p\d$/))?.name || '-'
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
          .map(
            (i) =>
              `  #${i.number} ${i.title} (${scopeCell(i.body)})`,
          )
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
  const needsHuman = issues.filter((i) =>
    i.labels?.some((l) => l.name === 'needs-human'),
  )
  const humanLines = [
    '\n== needs-human ==',
    needsHuman.length
      ? needsHuman.map((i) => `  #${i.number}: ${i.title}`).join('\n')
      : '  (none)',
  ]

  // 4. Hub tail
  const hubIssue = issues.find(
    (i) => i.number === hubNumber || i.labels?.some((l) => l.name === 'hub'),
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
