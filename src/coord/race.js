const { cleanAgent } = require('./owner')

const evaluateClaimRace = (comments = [], currentAgent = '') => {
  const cleanCurrent = cleanAgent(currentAgent)

  const claims = comments
    .filter((c) => c.body?.trim().startsWith('**CLAIM**'))
    .map((c) => {
      const match = c.body.match(/\|\s*agent:\s*([^|\n]+)/)
      const agent = match ? cleanAgent(match[1]) : ''
      return {
        id: c.id,
        createdAt: new Date(c.createdAt).getTime(),
        agent,
      }
    })
    .sort((a, b) => a.createdAt - b.createdAt)

  if (!claims.length) return { won: true }

  const earliestClaim = claims[0]
  if (earliestClaim.agent === cleanCurrent) {
    return { won: true }
  }

  return {
    won: false,
    earlierAgent: earliestClaim.agent,
    earlierTime: earliestClaim.createdAt,
  }
}

module.exports = {
  evaluateClaimRace,
}
