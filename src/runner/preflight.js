const { isMine } = require('../coord/owner')

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

const checkBacklogAvailability = async ({ github, agent = '' }) => {
  const issues = await github.listIssues()
  const nonHubIssues = issues.filter((i) => !i.labels?.some((l) => l.name === 'hub'))

  if (!nonHubIssues.length) {
    return {
      status: 'idle_empty',
      reason: 'backlog_empty',
      waitSeconds: 300,
    }
  }

  const myClaims = nonHubIssues.filter((i) => isMine(i, agent))
  if (myClaims.length > 0) {
    return {
      status: 'ready',
      reason: 'owned_claims',
      count: myClaims.length,
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
  if (openPrs.length > 0) {
    return {
      status: 'ready',
      reason: 'open_prs',
      count: openPrs.length,
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
}
