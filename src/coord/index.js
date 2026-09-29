const { cleanAgent, ownerOf, isMine } = require('./owner')
const { parseScope, checkScopeCollision } = require('./scope')
const { evaluateClaimRace } = require('./race')
const { formatBoard } = require('./formatters')

const CoordService = ({ github, agent = '', human = 'Sullux', now = Date.now } = {}) => {
  const cleanCurrent = cleanAgent(agent)

  const claim = async (number, { plan = '', eta = '' } = {}) => {
    const issue = await github.viewIssue(number)
    if (!issue) return { ok: false, error: `Issue #${number} not found` }

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

  const done = async (number, { pr = '' } = {}) => {
    const commentBody = `**DONE** | agent: agent-${cleanCurrent} | at: ${now()}${pr ? ` | pr: #${pr}` : ''}`
    await github.commentIssue(number, commentBody)
    await github.editIssue(number, {
      addLabels: ['status:done'],
      removeLabels: ['status:claimed', 'status:in-progress'],
    })
    return { ok: true, number }
  }

  const board = async () => {
    const issues = await github.listIssues()
    return formatBoard(issues, cleanCurrent)
  }

  return {
    claim,
    release,
    status,
    done,
    board,
    cleanCurrent,
  }
}

module.exports = {
  CoordService,
}
