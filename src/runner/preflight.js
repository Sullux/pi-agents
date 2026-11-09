const { isMine, cleanAgent } = require('../coord/owner')

const NON_ACTIONABLE_LABELS = [
  'hub',
  'status:claimed',
  'status:in-progress',
  'status:blocked',
  'status:in-review',
  'needs-human',
]

const isActionableUnclaimed = (issue) => {
  const labelNames = (issue.labels || []).map((l) => l.name)
  return !labelNames.some((l) => NON_ACTIONABLE_LABELS.includes(l))
}

const isPrAuthoredByAgent = (pr, agent, myOwnedIssues = []) => {
  const norm = cleanAgent(agent)
  if (!norm) return false

  const myNums = new Set(myOwnedIssues.map((i) => i.number))
  if (
    pr.closingIssuesReferences?.some((ref) => myNums.has(ref?.number || ref))
  ) {
    return true
  }

  for (const num of myNums) {
    if (
      pr.headRefName?.includes(String(num)) ||
      pr.title?.includes(`#${num}`) ||
      pr.title?.includes(`(${num})`)
    ) {
      return true
    }
  }

  if (pr.comments?.length) {
    const pat = new RegExp(
      `(?:\\(agent-${norm},?\\s*the author\\)|agent:\\s*(?:agent-)?${norm}\\s*\\(author\\))`,
      'i',
    )
    if (pr.comments.some((c) => pat.test(c.body || ''))) return true
  }

  return false
}

// #90: the verb list lives in ONE place, shared by the matcher and the gap classifier below. Two copies
// of it is how a signed PR could be called unreviewed while every arm stayed green: #87's writer and
// #87's consumer were pinned separately and never joined, and this file is the consumer.
const VERDICT_MARKERS = [
  'REVIEW',
  'RE-ATTEST',
  'APPROVE',
  'BLOCK',
  'RETRACTION',
]

// Any protocol-shaped attestation header, verdict verb or not. `**NON-SELF WITNESS for box 5** | agent:
// agent-charlie | measured at `a029d24...`` matches this and not the verb list - that is the shape the
// fleet writes on a PR thread which the matcher answers `false` about, silently.
const ATTESTATION_RE =
  /\*\*([^*]+)\*\*\s*\|\s*agent:\s*(?:agent-)?([a-z0-9-]+)/i

// The head token #89 made `coord review --pr` append, and the shape the fleet writes by hand (`| head
// \`dcc9637\``, no colon - delta's retraction, live on #84). Staleness is read ONLY from this shape: a
// verdict body quotes base SHAs and issue refs freely, and calling one of those a stale head invents a cause.
const HEAD_CITED_RE = /\bhead\b[:\s]*`?([0-9a-f]{7,40})/i

const verdictPattern = (norm) =>
  new RegExp(
    `\\*\\*(?:${VERDICT_MARKERS.join('|')})[^*]*\\*\\*\\s*\\|\\s*agent:\\s*(?:agent-)?${norm}\\b`,
    'i',
  )

const shortHead = (pr) => (pr.headRefOid ? pr.headRefOid.slice(0, 7) : '')

const isPrReviewedByAgent = (pr, agent) => {
  const norm = cleanAgent(agent)
  if (!norm || !pr.comments?.length) return false

  const shortSha = shortHead(pr)
  const revPat = verdictPattern(norm)

  return pr.comments.some((c) => {
    const body = c.body || ''
    if (!revPat.test(body)) return false
    return shortSha ? body.includes(shortSha) : true
  })
}

// Why did the matcher say "not reviewed by you"? `checkBacklogAvailability` turns a `false` into "go
// review this PR", and that is the right advice for an unreviewed thread and the wrong frame for every
// other cause - so the cause is named rather than the allowlist widened. The question this answers is
// "is a verdict owed on this PR?", NOT "has anyone attested here?": a one-box witness is not a verdict,
// which is why `WITNESS` is deliberately absent from VERDICT_MARKERS (#90's decision, measured off the
// caller rather than guessed). Widening would have laundered partial attestations into a reviewed state
// and dropped those PRs from the board - the false-negative direction, where work goes unseen.
const prReviewGap = (pr, agent) => {
  const norm = cleanAgent(agent)
  if (!norm)
    return {
      number: pr.number,
      gap: 'unmeasured',
      hint: 'no agent identity, so nothing is classifiable',
    }

  const shortSha = shortHead(pr)
  const bodies = (pr.comments || []).map((c) => c.body || '')
  const mine = bodies.filter((b) => verdictPattern(norm).test(b))

  if (mine.some((b) => (shortSha ? b.includes(shortSha) : true))) {
    return { number: pr.number, gap: 'reviewed', hint: '' }
  }

  const cited = mine
    .map((b) => HEAD_CITED_RE.exec(b)?.[1]?.slice(0, 7))
    .find((h) => h && h !== shortSha)
  if (cited) {
    return {
      number: pr.number,
      gap: 'stale-head-verdict',
      hint: `your verdict cites head \`${cited}\` but the head is now \`${shortSha || 'unknown'}\` - re-attest at the current head; a green measured at an old base is not evidence about this tree`,
    }
  }

  if (mine.length) {
    return {
      number: pr.number,
      gap: 'unsigned-verdict',
      hint: `your verdict on this thread carries no head token, so it cannot be matched to a commit - re-run \`page coord review <issue> --pr ${pr.number} "<verdict>"\` (#89 gives the writer that token)`,
    }
  }

  const witness = bodies
    .map((b) => ({ b, m: ATTESTATION_RE.exec(b) }))
    .find(
      ({ b, m }) =>
        m &&
        shortSha &&
        b.includes(shortSha) &&
        !VERDICT_MARKERS.some((v) => m[1].toUpperCase().startsWith(v)),
    )
  if (witness) {
    return {
      number: pr.number,
      gap: 'non-verdict-attestation',
      hint: `head-cited **${witness.m[1].trim()}** by ${witness.m[2]} attests one box, not the pull request - a verdict is still owed here`,
    }
  }

  return {
    number: pr.number,
    gap: 'unreviewed',
    hint: 'no verdict on this thread yet',
  }
}

const checkBacklogAvailability = async ({ github, agent = '' }) => {
  const issues = await github.listIssues()
  const nonHubIssues = issues.filter(
    (i) => !i.labels?.some((l) => l.name === 'hub'),
  )

  if (!nonHubIssues.length) {
    return {
      status: 'idle_empty',
      reason: 'backlog_empty',
      waitSeconds: 300,
    }
  }

  const allMyIssues = nonHubIssues.filter((i) => isMine(i, agent))
  const myActiveClaims = allMyIssues.filter(
    (i) => !i.labels?.some((l) => l.name === 'status:in-review'),
  )
  if (myActiveClaims.length > 0) {
    return {
      status: 'ready',
      reason: 'owned_claims',
      count: myActiveClaims.length,
    }
  }

  const unclaimed = nonHubIssues.filter(isActionableUnclaimed)
  if (unclaimed.length > 0) {
    return {
      status: 'ready',
      reason: 'unclaimed_tasks',
      count: unclaimed.length,
    }
  }

  const openPrs = await github.listPrs()
  const reviewablePrs = openPrs.filter(
    (pr) =>
      !isPrAuthoredByAgent(pr, agent, allMyIssues) &&
      !isPrReviewedByAgent(pr, agent),
  )

  if (reviewablePrs.length > 0) {
    // The count alone told an operator "N PRs need you" with no way to tell a signed-without-token
    // verdict from a moved head from a thread nobody has touched. Carried on the object, not rebuilt
    // by the renderer, so the advice cannot drift from the state it describes.
    return {
      status: 'ready',
      reason: 'open_prs',
      count: reviewablePrs.length,
      reviewGaps: reviewablePrs.map((pr) => prReviewGap(pr, agent)),
    }
  }

  return {
    status: 'idle_busy',
    reason: 'peer_contention',
    waitSeconds: 60,
  }
}

module.exports = {
  checkBacklogAvailability,
  isPrAuthoredByAgent,
  isPrReviewedByAgent,
  prReviewGap,
  VERDICT_MARKERS,
}
