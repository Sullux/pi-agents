const { cleanAgent, ownerOf, isMine } = require('./owner')
const { parseScope, checkScopeCollision } = require('./scope')
const { evaluateClaimRace } = require('./race')
const { formatBoard, formatSync } = require('./formatters')

const CoordService = ({
  github,
  agent = process.env.COORD_AGENT || '',
  human = process.env.COORD_HUMAN || 'Sullux',
  now = Date.now,
} = {}) => {
  const cleanCurrent = cleanAgent(agent)

  const claim = async (number, { plan = '', eta = '' } = {}) => {
    const issue = await github.viewIssue(number)
    if (!issue) return { ok: false, error: `Issue #${number} not found` }

    const currentOwner = ownerOf(issue)
    if (currentOwner && currentOwner !== cleanCurrent) {
      return {
        ok: false,
        error: `#${number} is already claimed by ${currentOwner}`,
      }
    }

    const files = parseScope(issue.body)
    if (!files.length) {
      return { ok: false, error: `#${number} declares no Files scope` }
    }

    const allIssues = await github.listIssues()
    const collision = checkScopeCollision(files, allIssues, cleanCurrent)
    if (collision.hasCollision) {
      return {
        ok: false,
        error: `#${number} file scope collides with #${collision.collidingIssue} held by ${collision.collidingAgent} (${collision.collidingFile})`,
      }
    }

    const timestamp = now()
    const commentBody =
      `**CLAIM** | agent: agent-${cleanCurrent} | human: @${human} | at: ${timestamp}\n\n` +
      `plan: ${plan || '_(none given)_'}\neta: ${eta || '_(none given)_'}`

    await github.commentIssue(number, commentBody)
    await github.editIssue(number, {
      addLabels: ['status:claimed'],
      removeLabels: ['status:unclaimed', 'status:blocked'],
    })

    const refreshed = await github.viewIssue(number)
    const raceResult = evaluateClaimRace(refreshed.comments, cleanCurrent)
    if (!raceResult.won) {
      const releaseComment = `**RELEASE** | agent: agent-${cleanCurrent} | reason: lost claim race to ${raceResult.earlierAgent}`
      await github.commentIssue(number, releaseComment)
      return {
        ok: false,
        error: `Lost simultaneous claim race to ${raceResult.earlierAgent}`,
      }
    }

    return { ok: true, number }
  }

  const release = async (number, { reason = '' } = {}) => {
    const commentBody = `**RELEASE** | agent: agent-${cleanCurrent} | reason: ${reason || 'unspecified'}`
    await github.commentIssue(number, commentBody)
    await github.editIssue(number, {
      addLabels: ['status:unclaimed'],
      removeLabels: ['status:claimed', 'status:in-progress'],
    })
    return { ok: true, number }
  }

  const status = async (number, message = '') => {
    const commentBody = `**STATUS** | agent: agent-${cleanCurrent} | at: ${now()}\n\n${message}`
    await github.commentIssue(number, commentBody)
    return { ok: true, number }
  }

  const done = async (number, { pr = '', text = '' } = {}) => {
    const commentBody =
      `**DONE** | agent: agent-${cleanCurrent} | at: ${now()}` +
      (pr ? ` | pr: #${pr}` : '') +
      (text ? `\n\n${text}` : '')
    await github.commentIssue(number, commentBody)
    await github.editIssue(number, {
      addLabels: ['status:done'],
      removeLabels: ['status:claimed', 'status:in-progress'],
    })
    if (github.closeIssue) {
      await github.closeIssue(number)
    }
    return { ok: true, number }
  }

  const hub = async (text = '') => {
    const hubNumber = Number(process.env.COORD_HUB || 4)
    const cleanedText = text.replace(/^(on|blocked|next)\s+/i, '').trim()
    const commentBody = `${cleanCurrent} | human: @${human}\n${cleanedText}`
    await github.commentIssue(hubNumber, commentBody)
    return { ok: true, hubNumber }
  }

  const board = async () => {
    const issues = await github.listIssues()
    return formatBoard(issues, cleanCurrent, github.repo)
  }

  const sync = async () => {
    const issues = await github.listIssues()
    return formatSync({
      issues,
      currentAgent: cleanCurrent,
      repo: github.repo,
      now: now(),
    })
  }

  return {
    claim,
    release,
    status,
    done,
    hub,
    board,
    sync,
    cleanCurrent,
  }
}

module.exports = {
  CoordService,
}
