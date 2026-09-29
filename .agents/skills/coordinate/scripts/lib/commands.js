const { cleanAgent, ownerOf, isMine } = require('./owner')
const { parseScope, checkScopeCollision } = require('./scope')
const { evaluateClaimRace } = require('./race')
const { formatBoard, formatSync } = require('./formatters')

const Commands = ({
  github,
  agent = process.env.COORD_AGENT || '',
  human = process.env.COORD_HUMAN || 'Sullux',
  now = Date.now,
} = {}) => {
  const cleanCurrent = cleanAgent(agent)

  const sync = async () => {
    const issues = await github.listIssues()
    return formatSync({
      issues,
      currentAgent: cleanCurrent,
      repo: github.repo,
      now: now(),
    })
  }

  const board = async () => {
    const issues = await github.listIssues()
    return formatBoard(issues, cleanCurrent, github.repo)
  }

  const claim = async (number, { plan = '', eta = '' } = {}) => {
    const issue = await github.viewIssue(number)
    if (!issue) throw new Error(`Issue #${number} not found`)

    const currentOwner = ownerOf(issue)
    if (currentOwner && currentOwner !== cleanCurrent) {
      throw new Error(`#${number} is already claimed by ${currentOwner}`)
    }

    const files = parseScope(issue.body)
    if (!files.length) {
      throw new Error(
        `#${number} declares no Files scope - add a '## Files' section before claiming`,
      )
    }

    const allIssues = await github.listIssues()
    const collision = checkScopeCollision(files, allIssues, cleanCurrent)
    if (collision.hasCollision) {
      throw new Error(
        `#${number} file scope collides with #${collision.collidingIssue} held by ${collision.collidingAgent} (${collision.collidingFile})`,
      )
    }

    const timestamp = new Date(now()).toISOString()
    const commentBody =
      `**CLAIM** | agent: agent-${cleanCurrent} | human: @${human} | at: ${timestamp}\n\n` +
      `plan: ${plan || '_(none given)_'}\neta: ${eta || '_(none given)_'}`

    await github.commentIssue(number, commentBody)
    await github.editIssue(number, {
      addLabels: ['status:claimed'],
      removeLabels: ['status:unclaimed', 'status:blocked'],
    })

    // Verification check for race condition
    const refreshed = await github.viewIssue(number)
    const raceResult = evaluateClaimRace(refreshed.comments, cleanCurrent)
    if (!raceResult.won) {
      const releaseComment = `**RELEASE** | agent: agent-${cleanCurrent} | reason: lost claim race to ${raceResult.earlierAgent}`
      await github.commentIssue(number, releaseComment)
      throw new Error(
        `Lost simultaneous claim race to ${raceResult.earlierAgent} (earlier timestamp)`,
      )
    }

    return `Claimed #${number}`
  }

  const release = async (number, { reason = '', stale = false } = {}) => {
    const issue = await github.viewIssue(number)
    if (!issue) throw new Error(`Issue #${number} not found`)

    if (!stale && !isMine(issue, cleanCurrent)) {
      throw new Error(
        `Cannot release #${number} - not claimed by agent-${cleanCurrent}`,
      )
    }

    const commentBody = `**RELEASE** | agent: agent-${cleanCurrent} | reason: ${reason || 'unspecified'}`
    await github.commentIssue(number, commentBody)
    await github.editIssue(number, {
      addLabels: ['status:unclaimed'],
      removeLabels: ['status:claimed', 'status:in-progress'],
    })
    return `Released #${number}`
  }

  const hub = async (text = '') => {
    const hubNumber = Number(process.env.COORD_HUB || 4)
    // Strip leading subverbs like 'on', 'blocked', 'next'
    const cleanedText = text.replace(/^(on|blocked|next)\s+/i, '').trim()
    const commentBody = `${cleanCurrent} | human: @${human}\n${cleanedText}`
    await github.commentIssue(hubNumber, commentBody)
    return `Posted to hub #${hubNumber}`
  }

  const status = async (number, text = '') => {
    const commentBody = `**STATUS** | agent: agent-${cleanCurrent} | at: ${new Date(now()).toISOString()}\n\n${text}`
    await github.commentIssue(number, commentBody)
    return `Status posted on #${number}`
  }

  const done = async (number, { pr = '', text = '' } = {}) => {
    const commentBody =
      `**DONE** | agent: agent-${cleanCurrent} | at: ${new Date(now()).toISOString()}` +
      (pr ? ` | pr: #${pr}` : '') +
      (text ? `\n\n${text}` : '')
    await github.commentIssue(number, commentBody)
    await github.editIssue(number, {
      addLabels: ['status:done'],
      removeLabels: ['status:claimed', 'status:in-progress'],
    })
    await github.closeIssue(number)
    return `Closed #${number} as done`
  }

  return {
    sync,
    board,
    claim,
    release,
    hub,
    status,
    done,
  }
}

module.exports = {
  Commands,
}
