const cleanAgent = (name = '') =>
  name
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/^pi\//, '')
    .replace(/^agent-/, '')
    .trim()

const PROTOCOL_REGEX = /^\*\*(CLAIM|RELEASE|HANDOFF|DONE)\*\*/

// Shared protocol parsers. `markerOf`/`agentOf` used to live inside race.js as private
// copies; both files now read the same two tokens so "who posted this line" cannot drift
// between the ownership notion (ownerOf) and the arbitration notion (liveClaims).
const markerOf = (body = '') => {
  const match = body.trim().match(/^\*\*([A-Z]+)\*\*/)
  return match ? match[1] : ''
}

const agentOf = (body = '') => {
  const match = body.match(/\|\s*agent:\s*([^|\n]+)/)
  return match ? cleanAgent(match[1]) : ''
}

const targetOf = (body = '') => {
  const match = body.match(/to:\s*@?([^\s|\n]+)/)
  return match ? cleanAgent(match[1]) : ''
}

// Ownership is a fold over the protocol timeline, not a lookup of its last line.
//
// The bug this closes (pi-agents#12, hit live on pitcairn-portal#1030): `ownerOf` took the
// LAST protocol comment and returned an owner only for CLAIM/HANDOFF, so ANY trailing
// RELEASE *or DONE* projected `''`. When one agent closes another agent's claimed issue,
// the holder vanishes from the board (`OWNER` renders `-`), `checkScopeCollision` skips the
// issue entirely (`if (!owner) continue`), and `claim` stops refusing everyone else - while
// the issue is still OPEN, because a reopen followed. The holder was fenced out of their own
// issue by a close-out they did not sign, and the reopen looked free.
//
// So a close-out de-owns only its own poster:
//   CLAIM                 -> holder := the poster
//   HANDOFF               -> holder := the `to:` target
//   RELEASE|DONE, poster == holder, or the line names no poster -> holder := ''
//   RELEASE|DONE, poster != holder (a third-party close-out)    -> holder unchanged
//
// The unattributed branch keeps the existing pins' behavior (both synthetic close-outs in
// test/coord/coord.test.js name no `agent:`): a line we cannot attribute is the last word
// written on the issue, so it clears. race.js is stricter in exactly that case - it disarms
// per-agent, so an unattributed marker frees nobody - which is a DELIBERATE divergence, not
// an oversight: see the reconciliation note in race.js's header.
const applyMarker = (owner, body) => {
  const kind = markerOf(body)
  const agent = agentOf(body)
  if (kind === 'CLAIM') return agent
  if (kind === 'HANDOFF') return targetOf(body)
  if (kind === 'RELEASE' || kind === 'DONE')
    return !agent || agent === owner ? '' : owner
  return owner
}

const ownerOf = (issue) => {
  const protocol = (issue?.comments || [])
    .map((c) => c.body?.trim() || '')
    .filter((body) => PROTOCOL_REGEX.test(body))
  if (!protocol.length) return ''
  return protocol.reduce(applyMarker, '')
}

const isMine = (issue, agent) => {
  const cleanCurrent = cleanAgent(agent)
  const owner = cleanAgent(ownerOf(issue))
  return Boolean(cleanCurrent && owner === cleanCurrent)
}

// #28: did this agent EVER sign a CLAIM on this issue, live or not? `ownerOf` answers "who holds
// it now", which is the wrong question for the reopen-then-reclose flow: a claimant whose own
// DONE (or a RELEASE) already de-owned the issue is still the person who claimed it, and forcing
// them through --force to finish their own close-out would train the fleet to reach for the
// override on routine work. Same two shared parsers as ownerOf, so the token shape cannot drift.
const hasClaimBy = (comments = [], agent = '') => {
  const clean = cleanAgent(agent)
  if (!clean) return false
  return (comments || []).some(
    (c) => markerOf(c.body) === 'CLAIM' && agentOf(c.body) === clean,
  )
}

module.exports = {
  cleanAgent,
  markerOf,
  agentOf,
  ownerOf,
  isMine,
  hasClaimBy,
}
