const { cleanAgent, markerOf, agentOf } = require('./owner')

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
// pi-agents#12 asks whether this list should still contain DONE now that ownerOf treats a
// close-out as the POSTER's own act. It should, and the two notions are now consistent rather
// than merely different: liveClaims disarms per-agent (`live.delete(entry.agent)`), so a DONE
// signed by a bystander never frees the holder - which is exactly what ownerOf does. What each
// function answers is different ("who still holds this?" vs "whose claim can win a race?"), but
// neither lets a third party sign someone else's release.
const TERMINATING_MARKERS = ['RELEASE', 'DONE', 'HANDOFF']

// ONE deliberate divergence remains, and it is the unattributed marker: a RELEASE/DONE line
// that names no `agent:` clears ownership in ownerOf (we cannot attribute it, so we treat it as
// the last word written on the issue - the behavior every existing pin depends on), while here
// it disarms NOBODY (`live.delete('')` is a no-op), so a race is still refused. Divergence is
// safe in that direction: the gate is the loud one and the fence is the quiet one. Coord's own
// verbs always sign their protocol lines with `| agent:`, so the case is a hand-written comment.

// Rule C ordering: earliest timestamp wins, same-second ties fall to comment-id order.
const byArrival = (a, b) => a.at - b.at || a.id.localeCompare(b.id)

const protocolTimeline = (comments = []) =>
  comments
    .map((c) => ({
      // `id` participates in same-second tie-breaking (Rule C), so a caller that omits ids
      // still gets a deterministic order - String(undefined ?? '') is '' for all of them.
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
