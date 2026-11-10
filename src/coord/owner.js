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

// Two shapes, tried in this order, and the order is the safety property.
//
// `STRICT` is the form `claim` writes: a `|`-delimited field. It wins whenever it matches,
// which is what stops a body that QUOTES a peer's claim line after its own field from being
// re-attributed to the quoted peer (pinned). `LINE` is the fallback for a hand-authored
// claim - the field at the start of a line, with no pipe in front of it, either because the
// writer put an extra field first or because the field wrapped to a continuation line.
// Without the fallback an unparseable field silently means "nobody claimed this", which
// reads on the board and in the scope gate as free (#49).
const AGENT_STRICT = /\|\s*agent:\s*([^|\n]+)/
// Optional leading marker so `**CLAIM** agent: X` (no pipe at all) resolves too, and an
// optional list bullet. `RELEASE`/`DONE` bodies that merely mention an agent in prose do not
// match, because they still need the literal `agent:` token in field position.
const AGENT_LINE =
  /^[ \t]*(?:\*\*[A-Z]+\*\*[ \t]*(?:\|[ \t]*)?)?(?:[-*] )?agent:[ \t]*([^\s|]+)/m

const agentOf = (body = '') => {
  const strict = body.match(AGENT_STRICT)
  if (strict) return cleanAgent(strict[1])
  const line = body.match(AGENT_LINE)
  return line ? cleanAgent(line[1]) : ''
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
// So a close-out de-owns only its own poster, and (pi-agents#102) a claim-out is earliest-wins:
//   CLAIM                 -> holder := the poster, ONLY when the slot is empty - Rule C in the fold
//   HANDOFF               -> holder := the `to:` target
//   RELEASE|DONE, poster == holder, or the line names no poster -> holder := ''
//   RELEASE|DONE, poster != holder (a third-party close-out)    -> holder unchanged
//
// #102 restated the CLAIM line from `agent || owner` to `owner || agent`, and it is a precedence
// rule, not another guard beside the fold - see the ordering argument recorded in the #96 header:
// a rule nobody calls is a comment. pitcairn#1218's four real bytes are the witness: bravo claimed
// at 00:04:32Z, alpha stamped 12 seconds later (the old fold MOVED the holder to alpha), then alpha
// RELEASED twice as the honest loser - poster == holder after the displacement, so #12's own
// clearing guard fired and the issue projected OWNERLESS while the earliest claim still stood
// uncontested. Concede-with-credit was supposed to be SAFE; under last-wins it deleted the real
// owner, which is the #238 pileup arriving from the parser side. The handoff routes that remain are
// the holder's own RELEASE (slot empties, the next CLAIM takes) or a HANDOFF naming the recipient;
// a late CLAIM is a Rule-C loser and the fold now says so structurally. Consequence for #52: the
// race was always earliest-wins while ownership was last-word, and its header documented the
// disagreement as a fact - folding Rule C removes the divergence, so the rival-after-me arm of
// test/cli/claim-selfcheck.test.js is restated there, not deleted.
//
// The unattributed branch keeps the existing pins' behavior (both synthetic close-outs in
// test/coord/coord.test.js name no `agent:`): a line we cannot attribute is the last word
// written on the issue, so it clears. race.js is stricter in exactly that case - it disarms
// per-agent, so an unattributed marker frees nobody - which is a DELIBERATE divergence, not
// an oversight: see the reconciliation note in race.js's header.
// A CLAIM or HANDOFF we cannot read must not move ownership.
//
// Clearing on an unreadable line is the dangerous direction: `checkScopeCollision` does
// `if (!owner) continue`, so the files under that claim stop being fenced for everyone else,
// and the board's OWNER column renders `-`. `RELEASE`/`DONE` keep clearing when
// unattributed - that is the documented divergence in race.js's header and three existing
// pins depend on it - because a close-out is the last word written on an issue.
const applyMarker = (owner, body) => {
  const kind = markerOf(body)
  const agent = agentOf(body)
  if (kind === 'CLAIM') return owner || agent
  if (kind === 'HANDOFF') return targetOf(body) || owner
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

// The residual case: a protocol marker whose identity field no parser could recover. It is
// NOT the same thing as "nobody claimed this", and callers need to be able to say so instead
// of quietly treating the issue as free. Empty array means every marker resolved.
const unresolvedProtocolLines = (comments = []) =>
  (comments || [])
    .map((c) => c.body?.trim() || '')
    .filter((body) => {
      const kind = markerOf(body)
      if (kind === 'CLAIM') return agentOf(body) === ''
      if (kind === 'HANDOFF') return targetOf(body) === ''
      return false
    })

// #66: the board needs a STATE, and in a repo that carries no `status:*` labels the only evidence
// of state is the protocol timeline. Derived from the SAME fold `ownerOf` runs, deliberately: a
// "last marker wins" reading would print `unclaimed` beside a holder that `applyMarker` keeps in
// place - a bystander's `DONE` on a claimed issue - which is a fresh instance of the exact
// contradiction this closes. Returns '' when the issue has no protocol line at all, so a caller can
// tell "no evidence" apart from "evidence of free".
const protocolStatus = (issue) => {
  const comments = issue?.comments || []
  const markers = comments
    .map((c) => c.body?.trim() || '')
    .filter((body) => markerOf(body) !== '')
  if (!markers.length) return ''
  // `review` posts **REVIEW** and, in a repo with labels, sets `status:in-review`; the marker is
  // the same claim in the other taxonomy, so it maps to the same cell.
  if (markerOf(markers[markers.length - 1]) === 'REVIEW') return 'in-review'
  // An unresolved CLAIM (#49) is "someone claimed this and we cannot read who", never "nobody did".
  if (ownerOf(issue) || unresolvedProtocolLines(comments).length)
    return 'claimed'
  return 'unclaimed'
}

module.exports = {
  cleanAgent,
  markerOf,
  agentOf,
  ownerOf,
  isMine,
  hasClaimBy,
  unresolvedProtocolLines,
  protocolStatus,
}
