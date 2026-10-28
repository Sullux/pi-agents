const { cleanAgent, ownerOf, isMine } = require('./owner')
const { isIssueNumber } = require('./issueNumber')
const { parseScope, checkScopeCollision, labelNames } = require('./scope')
const { evaluateClaimRace } = require('./race')
const { formatBoard, formatSync } = require('./formatters')
// #29 guard 2 lives with guard 1 in src/cli/hubText.js, which is where hub-text rules
// are composed, and that module requires nothing - so this edge cannot form a cycle.
// Applying it HERE rather than in the CLI is the whole point: the CLI hands hub() the
// raw message, hub() strips a leading `on|blocked|next` (#3), and a stamp prepended
// before that strip would hide the subverb behind it and resurrect the literal-`on`
// post #387 was filed for. Stamping the composed body keeps both guards live.
const { ensureStamp } = require('../cli/hubText')

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

  // #13: this is the load-bearing half of the guard. The CLI prints a friendly usage
  // line, but ANY caller of these five verbs - the shim, a future subcommand, a test
  // double - must not be able to reach commentIssue/editIssue/closeIssue with a
  // non-integer, because `NaN` turns into an issue IDENTIFIER in a board write rather
  // than an error. `claim` died on a stack trace; `done` would have tried to close
  // issue "NaN", which is a write, not a crash. The CLI refuses first, so a user sees
  // the usage message and this message is what a non-CLI caller gets.
  const invalidNumber = (number) => ({
    ok: false,
    error:
      `invalid issue number ${String(number)}: coord verbs address exactly one ` +
      'issue, given as a positive integer',
  })

  // #34: the protocol comment IS the record; labels are decoration, and a repo can simply
  // not have the taxonomy - pi-agents carries zero status:* labels, measured. Two gh refusals
  // used to arrive as one throw AFTER the comment was written: gh will not REMOVE a label the
  // issue does not carry, and will not ADD a label the repo never created. Every mutating verb
  // therefore exited 1 on work it had already done, and the retry re-claimed an issue the agent
  // already held - the #238 pileup shape, funded by a tool bug. Removals are now filtered against
  // what the issue actually has, so most calls never fire, and a residual failure comes back as a
  // warning instead of throwing. Swallowing it silently would be worse than the throw: an agent
  // that believes labels moved reads a board that never changed, so the CLI has to print this.
  const applyLabels = async (
    number,
    { addLabels = [], removeLabels = [], issue } = {},
  ) => {
    const present = labelNames(issue)
    const removable = removeLabels.filter((name) => present.includes(name))
    if (!addLabels.length && !removable.length) return {}
    // only the keys with work behind them: `done` historically sent no addLabels at all, and
    // a pin asserts that shape because an empty `--add-label` is exactly the doomed call this
    // issue is about
    const edits = {}
    if (addLabels.length) edits.addLabels = addLabels
    if (removable.length) edits.removeLabels = removable
    try {
      await github.editIssue(number, edits)
      return {}
    } catch (error) {
      return { labelWarning: String(error?.message || error).trim() }
    }
  }

  const claim = async (number, { plan = '', eta = '' } = {}) => {
    if (!isIssueNumber(number)) return invalidNumber(number)
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
    const labels = await applyLabels(number, {
      addLabels: ['status:claimed'],
      removeLabels: ['status:unclaimed', 'status:blocked'],
      issue,
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

    return { ok: true, number, warnings, ...labels }
  }

  const release = async (number, { reason = '' } = {}) => {
    if (!isIssueNumber(number)) return invalidNumber(number)
    const commentBody = `**RELEASE** | agent: agent-${cleanCurrent} | reason: ${reason || 'unspecified'}`
    await github.commentIssue(number, commentBody)
    // the view is only for the removal filter below - release used to hand gh a fixed list,
    // which is the half of #34 that fires on a repo that DOES have the taxonomy but whose
    // issue never passed through unclaimed
    const issue = await github.viewIssue(number)
    const labels = await applyLabels(number, {
      addLabels: ['status:unclaimed'],
      removeLabels: ['status:claimed', 'status:in-progress'],
      issue,
    })
    return { ok: true, number, ...labels }
  }

  const status = async (number, message = '') => {
    if (!isIssueNumber(number)) return invalidNumber(number)
    const commentBody = `**STATUS** | agent: agent-${cleanCurrent} | at: ${now()}\n\n${message}`
    await github.commentIssue(number, commentBody)
    return { ok: true, number }
  }

  const review = async (number, { pr = '', text = '' } = {}) => {
    if (!isIssueNumber(number)) return invalidNumber(number)
    const commentBody =
      `**REVIEW** | agent: agent-${cleanCurrent} | at: ${now()}` +
      (pr ? ` | pr: #${pr}` : '') +
      (text ? `\n\n${text}` : '')
    await github.commentIssue(number, commentBody)
    const issue = await github.viewIssue(number)
    const labels = await applyLabels(number, {
      addLabels: ['status:in-review'],
      removeLabels: labelNames(issue).filter(
        (name) => name?.startsWith('status:') && name !== 'status:in-review',
      ),
      issue,
    })
    return { ok: true, number, ...labels }
  }

  const done = async (number, { pr = '', text = '' } = {}) => {
    if (!isIssueNumber(number)) return invalidNumber(number)
    const commentBody =
      `**DONE** | agent: agent-${cleanCurrent} | at: ${now()}` +
      (pr ? ` | pr: #${pr}` : '') +
      (text ? `\n\n${text}` : '')
    await github.commentIssue(number, commentBody)
    const issue = await github.viewIssue(number)
    const labels = await applyLabels(number, {
      removeLabels: labelNames(issue).filter((name) =>
        name?.startsWith('status:'),
      ),
      issue,
    })
    // close is NOT part of the best-effort step: it is the outcome `done` exists to produce,
    // and #34 measured it succeeding on pi-agents while the label edit threw. A failed label
    // edit must never skip it, and a failed close must still throw loudly.
    if (github.closeIssue) {
      await github.closeIssue(number)
    }
    return { ok: true, number, ...labels }
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
    // #2: hub() posted a bare `alpha | human: @Sullux` header - no verb marker, no
    // timestamp - while every other protocol verb emits `**CLAIM**`/`**STATUS**`/`**DONE**`
    // with `at:`. The hub is the documented session entry point, so a SYNC line was not
    // classifiable by shape and carried no ordering information: two updates from the same
    // agent were indistinguishable, and the #3 contentless post was indistinguishable from
    // a terse one. Marker is the FIRST line so a reader can classify without reading bodies.
    const commentBody =
      `**SYNC** | agent: agent-${cleanCurrent} | human: @${human} | at: ${now()}` +
      `\n\n${cleanedText}`
    // The stamp check refuses BEFORE the call, like the two guards above it: a hub line
    // is a fleet timeline, and a post that reports success while carrying no readable
    // time (or a bogus one the author typed) is the defect #29 was filed for.
    const stamped = ensureStamp(commentBody, now)
    if (stamped.error) return { ok: false, error: stamped.error }
    await github.commentIssue(hubNumber, stamped.text)
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
