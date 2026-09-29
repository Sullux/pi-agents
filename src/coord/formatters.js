const { ownerOf, cleanAgent } = require('./owner')
const { parseScope } = require('./scope')

const pad = (str = '', len = 0) => (str.length >= len ? str.slice(0, len) : str + ' '.repeat(len - str.length))

const formatBoard = (issues = [], currentAgent = '') => {
  const cleanCurrent = cleanAgent(currentAgent)
  const nonHubIssues = issues.filter((i) => !i.labels?.some((l) => l.name === 'hub'))

  const lines = [
    '== board ==',
    'ISSUE  STATUS       WS              P   OWNER         TITLE                                        FILES',
  ]

  for (const issue of nonHubIssues) {
    const owner = ownerOf(issue)
    const statusLabel =
      issue.labels?.find((l) => l.name.startsWith('status:'))?.name.replace('status:', '') || 'unclaimed'
    const wsLabel = issue.labels?.find((l) => l.name.startsWith('ws:'))?.name.replace('ws:', '') || '-'
    const pLabel = issue.labels?.find((l) => l.name.match(/^p\d$/))?.name || '-'
    const files = parseScope(issue.body).join(' ') || '-'
    const ownerDisplay = owner ? (owner === cleanCurrent ? `*${owner}*` : owner) : '-'

    lines.push(
      `${pad(`#${issue.number}`, 6)} ` +
        `${pad(statusLabel, 12)} ` +
        `${pad(wsLabel, 15)} ` +
        `${pad(pLabel, 3)} ` +
        `${pad(ownerDisplay, 13)} ` +
        `${pad(issue.title, 44)} ` +
        `${files}`,
    )
  }

  return lines.join('\n')
}

module.exports = {
  formatBoard,
  pad,
}
