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
  if (kind === 'CLAIM') return agent || owner
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

// #96: the completion fence. Measured live on pitcairn #1212: delta posted **DONE** at 23:41:05Z,
// bravo CLAIMED 23 seconds after it and CLOSED 27 seconds after it, and no verb refused. `ownerOf`
// cannot see this case by construction: a self-posted DONE clears the holder, so the board projects
// `unclaimed` and every ownership-shaped check follows it - the recorded LOSSY-projection class
// wearing a completion hat. The fence is a SECOND fold over the same timeline, deliberately not
// folded into applyMarker: ownership answers "who holds it", completion answers "has anyone already
// signed the work off", and #1212 is what happens when those two questions share one state.
//
// Rules, and each one is an arm in test/coord/claim-stale-timeline.test.js:
//   DONE by X                     -> fence := {X, at} (an UNATTRIBUTED DONE fences no one -
//       refusing for a line nobody can name would lock every agent out of a prose quote, and unlike
//       applyMarker's clearing rule, fencing is the side that needs the name to exclude the poster)
//   RELEASE by X, or unattributed -> fence lifted (the completer retracts their own completion;
//       a third party cannot retract someone else's - they can only ask, and their own claim becomes
//       possible once the holder releases)
//   HANDOFF naming me -> protects me, exactly like a prior CLAIM (see the #100 clause below);
//       any other line -> leave the fence ALONE: a CLAIM that landed after a DONE is
//       itself the bug this closes and must not launder into an excuse
//   the fence never blocks its own poster: re-closing your own completed issue is routine.
//   #28 UNION (this is the forward-port #96's sequencing line predicted): a PRIOR LIVE CLAIM by
//       me under the DONE protects me. pitcairn #1030's lesson is that a bystander's close-out
//       must not fence the holder out of their own issue, and test/coord's existing arm for
//       "another agent's DONE closed out MY claim: still mine to close" is #28's pin - an earlier
//       claim means someone overwrote MY close-out; a later one means I am trying to claim over
//       THEIR completion. Order is decided by the `at:` stamp WHENEVER BOTH LINES CARRY ONE (the
//       tool writes them, and a race can make array position and arrival disagree - the post-write
//       arm in test/coord/claim-stale-timeline.test.js is exactly that case), falling back to line
//       position only when a stamp is missing. Releasing my own claim re-arms the fence: once I
//       stand down, the completion is the only surviving word on the work.
//   A HANDOFF naming me is a live hold for THIS rule too (bravo's ask on PR #100, decided here
//       rather than left implicit): `applyMarker` already counts a handoff as ownership, so an agent
//       handed an issue who then finds a bystander's DONE on it is the holder by the same evidence
//       the board projects. Fencing them while protecting a CLAIMer is the asymmetry that makes
//       `--force` the only exit for a legitimate close, so both routes set the same protection
//       state. The dissenting reading - a DONE is a stronger record than a handoff - is why this is
//       written down rather than merely coded: to fence handoffs, change this clause and its arm
//       together, not the code alone.
//   The stamp fallback reads BOTH comment shapes, because there are two: `viewIssue` is GraphQL and
//       delivers `createdAt` as an ISO string, while REST callers and the fixtures deliver
//       `created_at`, sometimes already numeric. A `created_at`-only fallback is inert on the
//       transport that matters - measured by bravo at PR #100, where arm 9 pinned a field production
//       never sends. The fallback COERCES to ms rather than passing the string through: the ordering
//       rule below compares numbers, and a raw ISO stamp would make `myClaimAt < at` false by NaN
//       coercion, which reads as "my claim was later" and strips protection from the rightful
//       holder. A live DONE with no stamp at all still fences; only the ORDER defaults to the
//       claimant, which is the safe direction.
const completedByOther = (comments = [], agent = '') => {
  const clean = cleanAgent(agent)
  let fence = null
  let myClaimAt = null
  // #96 + #102, the seam bravo named on PR #100: the fence compared stamps with `<`, so a pair
  // carrying the SAME `at:` (two tool writes inside one millisecond, which the #102 fixture bytes
  // reproduce) left `protectedByPriorClaim` false and refused MY close while `applyMarker` - which
  // resolves the same tie by ARRAY ORDER, earliest CLAIM wins - still projected me as the holder.
  // One timeline, two answers, in the same file. Rule C's tie-break is comment order, so the fence
  // now defers to it on equal stamps: an earlier line protects, a later one does not.
  let myClaimIdx = -1
  let idx = -1
  for (const c of comments || []) {
    idx++
    const body = c.body?.trim() || ''
    const kind = markerOf(body)
    const who = agentOf(body)
    const stamped = () => {
      const m = body.match(/\|\s*at:\s*(\d+)/)
      if (m) return Number(m[1])
      // GraphQL (`gh issue view --json comments`) delivers `createdAt` as an ISO string; REST and
      // the fixtures deliver `created_at`, sometimes already a number. Reading only `created_at`
      // made the fallback dead in production (bravo's ask on PR #100), and returning the raw string
      // would have made every ordering compare below a NUMBER vs a STRING - `1700000009000 <
      // '2026-11-10T04:00:00Z'` is false because the string coerces to NaN, which silently flips
      // the #28 protection the other way. Normalize to ms so ordering means what it says.
      const raw = c.createdAt ?? c.created_at ?? null
      if (raw == null) return null
      if (typeof raw === 'number') return raw
      const parsed = Date.parse(raw)
      return Number.isNaN(parsed) ? null : parsed
    }
    if (kind === 'CLAIM') {
      if (clean && who === clean) {
        myClaimAt = stamped()
        myClaimIdx = idx
      }
      continue
    }
    if (kind === 'HANDOFF') {
      // a handoff TO me is the live hold `applyMarker` already honors; see the rules block
      if (clean && targetOf(body) === clean) {
        myClaimAt = stamped()
        myClaimIdx = idx
      }
      continue
    }
    if (kind === 'RELEASE') {
      if (!who || who === clean) {
        myClaimAt = null
        myClaimIdx = -1
        if (fence?.protectedByPriorClaim) {
          fence = { ...fence, protectedByPriorClaim: false }
        }
      }
      if (fence && (!who || who === fence.agent)) fence = null
      continue
    }
    if (kind === 'DONE' && who) {
      const at = stamped()
      const bothStamps = myClaimAt != null && at != null
      const sameStampTie = myClaimAt != null && myClaimAt === at && myClaimIdx < idx
      fence = {
        agent: who,
        at,
        protectedByPriorClaim:
          myClaimAt != null && (!bothStamps || myClaimAt < at || sameStampTie),
      }
    }
  }
  if (!fence || fence.agent === clean) return null
  return fence.protectedByPriorClaim ? null : fence
}

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
  completedByOther,
  unresolvedProtocolLines,
  protocolStatus,
}
