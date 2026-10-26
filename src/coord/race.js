const { cleanAgent } = require('./owner')

// A claim is LIVE only until the same agent RELEASEs, DONEs or HANDOFFs it.
// Without that, the earliest **CLAIM** in an issue's whole history wins forever
// and a released issue becomes unclaimable by anyone but its first claimant -
// measured on pitcairn-portal#800: bravo claimed 17:44:19Z, released 17:51:12Z,
// and delta's 18:39:03Z claim was refused as a "simultaneous claim race" lost to
// an agent that had not held the issue for 48 minutes. The board then read
// status:unclaimed while every non-bravo claim attempt failed: a p1 orphaned by
// its own coordination tool, and ownerOf() (which IS release-aware) disagreed
// with this function, so the pre-claim check said "free" and the post-claim
// check contradicted it.
const TERMINATING_MARKERS = ['RELEASE', 'DONE', 'HANDOFF']

const markerOf = (body = '') => {
  const match = body.trim().match(/^\*\*([A-Z]+)\*\*/)
  return match ? match[1] : ''
}

const agentOf = (body = '') => {
  const match = body.match(/\|\s*agent:\s*([^|\n]+)/)
  return match ? cleanAgent(match[1]) : ''
}

// Rule C ordering: earliest timestamp wins, same-second ties fall to comment-id order.
const byArrival = (a, b) => a.at - b.at || a.id.localeCompare(b.id)

const protocolTimeline = (comments = []) =>
  comments
    .map((c) => ({
      id: String(c.id ?? ''),
      at: new Date(c.createdAt).getTime(),
      kind: markerOf(c.body),
      agent: agentOf(c.body),
    }))
    .filter((c) => c.kind === 'CLAIM' || TERMINATING_MARKERS.includes(c.kind))
    .sort(byArrival)

// Walk the timeline once: a CLAIM arms its agent, that agent's own
// RELEASE/DONE/HANDOFF disarms it. Status and discussion comments are inert.
const liveClaims = (comments = []) => {
  const live = new Map()
  for (const entry of protocolTimeline(comments)) {
    if (entry.kind === 'CLAIM') {
      if (!live.has(entry.agent)) live.set(entry.agent, entry)
    } else {
      live.delete(entry.agent)
    }
  }
  return [...live.values()].sort(byArrival)
}

const evaluateClaimRace = (comments = [], currentAgent = '') => {
  const cleanCurrent = cleanAgent(currentAgent)
  const claims = liveClaims(comments)

  if (!claims.length) return { won: true }

  const earliestClaim = claims[0]
  if (earliestClaim.agent === cleanCurrent) {
    return { won: true }
  }

  return {
    won: false,
    earlierAgent: earliestClaim.agent,
    earlierTime: earliestClaim.at,
  }
}

module.exports = {
  evaluateClaimRace,
  liveClaims,
}
