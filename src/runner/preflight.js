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

const isPrReviewedByAgent = (pr, agent) => {
  const norm = cleanAgent(agent)
  if (!norm || !pr.comments?.length) return false

  const shortSha = pr.headRefOid ? pr.headRefOid.slice(0, 7) : ''
  const revPat = new RegExp(
    `\\*\\*(?:REVIEW|RE-ATTEST|APPROVE|BLOCK|RETRACTION)[^*]*\\*\\*\\s*\\|\\s*agent:\\s*(?:agent-)?${norm}\\b`,
    'i',
  )

  return pr.comments.some((c) => {
    const body = c.body || ''
    if (!revPat.test(body)) return false
    return shortSha ? body.includes(shortSha) : true
  })
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
    return {
      status: 'ready',
      reason: 'open_prs',
      count: reviewablePrs.length,
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
}
