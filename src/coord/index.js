const { cleanAgent, ownerOf, isMine } = require('./owner')
const { parseScope, checkScopeCollision } = require('./scope')
const { evaluateClaimRace } = require('./race')
const { formatBoard, formatSync } = require('./formatters')

// `gh issue list --json comments` returns only the FIRST 100 comments of an issue
// (measured on hub #4: 100 returned, 645 real), so every timeline-dependent read
// built on it - ownerOf's last-protocol-comment-wins, or the hub tail's slice(-5) -
// silently freezes at the hundredth comment forever. `gh issue view` returns them
// all, so re-fetch only the issues that reached the ceiling.
const COMMENT_PAGE_CEILING = 100

const CoordService = ({
  github,
  agent = process.env.COORD_AGENT || '',
  human = process.env.COORD_HUMAN || 'Sullux',
  now = Date.now,
} = {}) => {
  const cleanCurrent = cleanAgent(agent)

  const withFullTimelines = async (issues = []) => {
    const suspect = issues.filter(
      (i) => (i.comments || []).length >= COMMENT_PAGE_CEILING,
    )
    if (!suspect.length) return issues
    const refreshed = await Promise.all(
      suspect.map((i) => github.viewIssue(i.number)),
    )
    const byNumber = new Map(
      refreshed.filter(Boolean).map((r) => [r.number, r]),
    )
    const suspectNumbers = new Set(suspect.map((i) => i.number))
    // A failed re-fetch must stay VISIBLE: falling back to the truncated array
    // silently is how the stale tail shipped in the first place. But only a SUSPECT
    // has an unknown tail - an issue below the ceiling was never truncated, so
    // tagging it too cries wolf across the whole board and teaches agents to skip
    // the warning that matters (shipped in dae1e65, caught on the first live board).
    return issues.map(
      (i) =>
        byNumber.get(i.number) ||
        (suspectNumbers.has(i.number) ? { ...i, commentsTruncated: true } : i),
    )
  }

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

    const allIssues = await withFullTimelines(await github.listIssues())
    const collision = checkScopeCollision(files, allIssues, cleanCurrent, {
      number,
      body: issue.body,
    })
    if (collision.hasCollision) {
      return {
        ok: false,
        // #863: name the blocking STATUS and the escape. Without them the refusal does not tell
        // the claimant whether to wait for a merge, ask for a split, or rebase. The status goes
        // AFTER the existing wording so the pre-existing message pin is untouched.
        error:
          `#${number} file scope collides with #${collision.collidingIssue} held by ${collision.collidingAgent} (${collision.collidingFiles.join(', ')})` +
          ` - blocking issue is status:${collision.collidingStatus}; a line-anchored 'split: #${number}' in either body waives the pair`,
      }
    }

    // #863: an in-review overlap warns instead of fencing, but a warning nobody sees is not a
    // warning - it goes to stdout AND into the CLAIM comment, so a teammate reading the timeline
    // knows this branch owes a rebase.
    const warnings = collision.warnings || []
    const warningNote = warnings.length
      ? '\n\nscope: overlaps in-review work, rebase owed after it merges\n' +
        warnings
          .map((w) => `- #${w.issue} (${w.agent}) on ${w.files.join(', ')}`)
          .join('\n')
      : ''

    const timestamp = now()
    const commentBody =
      `**CLAIM** | agent: agent-${cleanCurrent} | human: @${human} | at: ${timestamp}\n\n` +
      `plan: ${plan || '_(none given)_'}\neta: ${eta || '_(none given)_'}` +
      warningNote

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

    return { ok: true, number, warnings }
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

  const review = async (number, { pr = '', text = '' } = {}) => {
    const commentBody =
      `**REVIEW** | agent: agent-${cleanCurrent} | at: ${now()}` +
      (pr ? ` | pr: #${pr}` : '') +
      (text ? `\n\n${text}` : '')
    await github.commentIssue(number, commentBody)
    const issue = await github.viewIssue(number)
    const existingStatusLabels = (issue?.labels || [])
      .map((l) => (typeof l === 'string' ? l : l.name))
      .filter(
        (name) => name.startsWith('status:') && name !== 'status:in-review',
      )
    await github.editIssue(number, {
      addLabels: ['status:in-review'],
      removeLabels: existingStatusLabels,
    })
    return { ok: true, number }
  }

  const done = async (number, { pr = '', text = '' } = {}) => {
    const commentBody =
      `**DONE** | agent: agent-${cleanCurrent} | at: ${now()}` +
      (pr ? ` | pr: #${pr}` : '') +
      (text ? `\n\n${text}` : '')
    await github.commentIssue(number, commentBody)
    const issue = await github.viewIssue(number)
    const existingStatusLabels = (issue?.labels || [])
      .map((l) => (typeof l === 'string' ? l : l.name))
      .filter((name) => name.startsWith('status:'))
    if (existingStatusLabels.length) {
      await github.editIssue(number, {
        removeLabels: existingStatusLabels,
      })
    }
    if (github.closeIssue) {
      await github.closeIssue(number)
    }
    return { ok: true, number }
  }

  const hub = async (text = '') => {
    const hubNumber = Number(process.env.COORD_HUB || 4)
    // #3: the strip also has to match a BARE subverb. `/\s+/` only fires when text
    // follows, so `page coord hub on` used to post the literal word `on` to the fleet
    // hub - a contentless coordination signal from a verb that reports success.
    const cleanedText = text.replace(/^(on|blocked|next)(\s+|$)/i, '').trim()
    // #3: second of the two guards. The strip above can empty a non-empty argument
    // (`hub on` resolves to 'on' in the CLI and to '' here), and an empty body still
    // yields a well-formed header that the API accepts - so refusing has to happen
    // AFTER cleaning, and BEFORE the call, or a contentless post reports success.
    if (!cleanedText) {
      return { ok: false, error: 'hub needs a message; nothing was posted' }
    }
    const commentBody = `${cleanCurrent} | human: @${human}\n${cleanedText}`
    await github.commentIssue(hubNumber, commentBody)
    return { ok: true, hubNumber }
  }

  const board = async () => {
    const issues = await withFullTimelines(await github.listIssues())
    return formatBoard(issues, cleanCurrent, github.repo)
  }

  const sync = async () => {
    const issues = await withFullTimelines(await github.listIssues())
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
    review,
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
