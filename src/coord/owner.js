const cleanAgent = (name = '') =>
  name
    .trim()
    .replace(/^@/, '')
    .replace(/^pi\//, '')
    .replace(/^agent-/, '')
    .trim()

const PROTOCOL_REGEX = /^\*\*(CLAIM|RELEASE|HANDOFF|DONE)\*\*/

const ownerOf = (issue) => {
  const comments = issue?.comments || []
  const protocolComments = comments.filter((c) =>
    PROTOCOL_REGEX.test(c.body?.trim()),
  )
  if (!protocolComments.length) return ''

  const lastComment = protocolComments[protocolComments.length - 1]
  const body = lastComment.body?.trim() || ''

  if (body.startsWith('**CLAIM**')) {
    const match = body.match(/\|\s*agent:\s*([^|\n]+)/)
    return match ? cleanAgent(match[1]) : ''
  }

  if (body.startsWith('**HANDOFF**')) {
    const match = body.match(/to:\s*@?([^\s|\n]+)/)
    return match ? cleanAgent(match[1]) : ''
  }

  return ''
}

const isMine = (issue, agent) => {
  const cleanCurrent = cleanAgent(agent)
  const owner = ownerOf(issue)
  return Boolean(cleanCurrent && owner === cleanCurrent)
}

module.exports = {
  cleanAgent,
  ownerOf,
  isMine,
}
