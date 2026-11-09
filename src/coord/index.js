const {
  cleanAgent,
  ownerOf,
  isMine,
  hasClaimBy,
  unresolvedProtocolLines,
} = require('./owner')
const { isIssueNumber, pullRequestRefusal } = require('./issueNumber')
const {
  parseScope,
  checkScopeCollision,
  labelNames,
  labelKey,
  labelKeys,
  filesSectionDiagnosis,
} = require('./scope')
const { evaluateClaimRace, liveClaims } = require('./race')
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

  // #30: one kind check for every mutating verb, run BEFORE the first write, so a mistyped number
  // cannot half-apply the way the measured incident did: `page coord review 1138 --pr 1138` (an
  // intended `review 1136 --pr 1138`) posted a **REVIEW** comment and stamped `status:in-review` on
  // PR #1138, exited 0, and left the issue the board reads holding nothing. GitHub numbers issues and
  // PRs in one sequence and resolves either, so `isIssueNumber` above is a NUMBER check, not a KIND
  // check - this is the kind half. Only the POSITIONAL is tested: `--pr <n>` legitimately addresses a
  // pull request, and refusing it would make the tool reject its own correct usage. The board read
  // paths (board / sync) deliberately do not pay the extra spawn.
  const refuseIfPullRequest = async (sub, number) => {
    const kind = await github.issueKind(number)
    return kind?.isPullRequest
      ? { ok: false, error: pullRequestRefusal(sub, number, kind) }
      : null
  }

  // #52: winning a race and being READABLE are two different facts, and today only the first one
  // is checked. evaluateClaimRace answers "did anybody claim this before me" and returns won:true
  // when it cannot see ANY live claim - so a CLAIM whose marker is not the first token of the body
  // (a paste that brought a `>`, a BOM, prose before the marker) or a rival line that lands between
  // the write and the refresh lets the tool print `Claimed #N` while ownerOf, the half the board and
  // the scope gate both read, answers "nobody" or names somebody else. Measured shapes, every one
  // { won: true, owner: not me }: my claim + a bystander's RELEASE with no agent field; my claim + my
  // own signed RELEASE; a `>`-pasted claim; my claim then a DONE quoting another agent in prose; and
  // my claim + a rival CLAIM with a LATER timestamp (the race is earliest-wins, ownership is
  // last-word-wins, so the two can genuinely disagree inside one refresh). The comment IS on GitHub
  // either way, which is why the remedy is branched: re-posting a line a rival already overwrote
  // would re-arm the race, and #49's unresolvedProtocolLines is deliberately named here because it
  // CANNOT see four of those five shapes (it only inspects lines whose marker parses) - the two
  // halves are complementary, and the message says which one stayed silent.
  const verifyPostedClaim = (refreshedIssue, number, postedBody) => {
    const owner = ownerOf(refreshedIssue)
    if (owner === cleanCurrent) return null
    const unresolved = unresolvedProtocolLines(refreshedIssue.comments || [])
    const shape = JSON.stringify(`${postedBody}`.slice(0, 44))
    const comments = (refreshedIssue.comments || []).map((c) =>
      `${c.body}`.trim(),
    )
    const echoed = comments.includes(`${postedBody}`.trim())
    const parsed = owner ? `agent-${owner}` : 'nobody'
    const detector = unresolved.length
      ? `#49's unresolvedProtocolLines named ${unresolved.length} line(s) with no readable agent field`
      : `#49's unresolvedProtocolLines found nothing: it flags only lines with NO agent field, and this line has a field it can read`
    // Two causes remain, and the discriminator is `owner`, not `echoed`: a rival line that
    // lands after mine leaves MY body in the read too, so "present" cannot tell the two apart, and
    // the remedies are opposite (stand down vs re-read).
    const cause = owner
      ? `the last protocol word on the timeline is ${parsed}'s, not yours, so the board says ${owner} holds it (ownership is last-word-wins while the race is earliest-wins, and one refresh can show both, mine intact). STAND DOWN per Rule C and write NOTHING, because a second CLAIM re-arms a race you already lost`
      : `your line is not in the read and nobody holds #${number} (${comments.length} comment(s) read), so either the read answered before the write landed or the issue has more comments than this path returns - the 100-comment ceiling that withFullTimelines exists for. RE-READ before you write anything: gh api "repos/${github.repo || '<owner>/<repo>'}/issues/${number}/comments" --paginate -q '.[].body' | tail -5, and re-post only once you have seen the line genuinely absent`
    return {
      ok: false,
      number,
      owner,
      echoed,
      unresolved,
      postedBody,
      error: `coord claim: #${number} was written but does not resolve to agent-${cleanCurrent} after re-reading its own timeline - ${cause}. ${detector}.`,
    }
  }

  // #52, the half that runs BEFORE the write: the identity going into the CLAIM line has to be
  // readable by the same parser the board uses, or the post is a phantom owner. Measured: an empty
  // COORD_AGENT writes `agent: agent-`, which unresolvedProtocolLines flags and ownerOf answers
  // "nobody" for, while claim still reported success because both sides of the comparison were the
  // empty string. Compose the body, ask #49's detector whether that exact line would resolve to
  // anything, and refuse without writing - nothing is stamped, so there is nothing to unwind
  // (#48's discipline: the guard's job is to stop the write, not to reinterpret it afterwards).
  const postedLineWouldResolve = (commentBody) =>
    Boolean(cleanCurrent) &&
    ownerOf({ comments: [{ body: commentBody }] }) === cleanCurrent &&
    unresolvedProtocolLines([{ body: commentBody }]).length === 0

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
      // gh's stderr is the sentence an operator needs; execFileSync's message prefixes it with
      // `Command failed: gh issue edit ...`, which repeats what the warning already says. Prefer
      // stderr, fall back to the message, and collapse to ONE line so the `  ! ` decoration from
      // the CLI actually covers the whole warning instead of its first line only.
      const detail = String(error?.stderr || error?.message || error)
        .replace(/\s+/g, ' ')
        .trim()
      return { labelWarning: detail }
    }
  }

  const claim = async (number, { plan = '', eta = '' } = {}) => {
    if (!isIssueNumber(number)) return invalidNumber(number)
    const notAnIssue = await refuseIfPullRequest('claim', number)
    if (notAnIssue) return notAnIssue
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
      // #26: the bare "declares no Files scope" was a catch-all for "the parser could not see mine",
      // so an author whose section used a setext heading was told the section was missing. The phrase
      // stays (four arms match on it); the real reason rides along.
      return {
        ok: false,
        error: `#${number} declares no Files scope - ${filesSectionDiagnosis(issue.body)}`,
      }
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

    // #52: refuse before the write when my own line would not be attributable, so the
    // board never has to discover an owner it cannot name.
    if (!postedLineWouldResolve(commentBody)) {
      return {
        ok: false,
        error: `coord claim: COORD_AGENT=${JSON.stringify(agent)} does not round-trip through the tool's own CLAIM field (agent-${cleanCurrent} would read back as ${JSON.stringify(ownerOf({ comments: [{ body: commentBody }] })) || 'nobody'}), so the board would show #${number} FREE - or name somebody else - while you believe you hold it, which is how the #238 pileups were funded. Set COORD_AGENT to a value with no pipe or newline and re-run; nothing was written.`,
      }
    }

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

    // #52: the race above proves nobody beat you to it; this proves the line you just wrote is
    // readable by the half of the tool that decides ownership. Runs AFTER the race, because a lost
    // race has a more specific cause to report and must keep its own message.
    const selfCheck = verifyPostedClaim(refreshed, number, commentBody)
    if (selfCheck) return selfCheck

    return { ok: true, number, warnings, ...labels }
  }

  const release = async (number, { reason = '' } = {}) => {
    if (!isIssueNumber(number)) return invalidNumber(number)
    const notAnIssue = await refuseIfPullRequest('release', number)
    if (notAnIssue) return notAnIssue
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
    const notAnIssue = await refuseIfPullRequest('status', number)
    if (notAnIssue) return notAnIssue
    const commentBody = `**STATUS** | agent: agent-${cleanCurrent} | at: ${now()}\n\n${message}`
    await github.commentIssue(number, commentBody)
    return { ok: true, number }
  }

  // #28: `review` deliberately has NO ownership check, and that is documented rather than
  // accidental. A verdict is supposed to come from someone other than the holder - the whole
  // point of the review gate is a second pair of eyes - so `ownerOf === self` is not a
  // precondition here. `done` below is different in kind: it DESTROYS the board state another
  // agent is working against (closes the issue and strips its status label), which is why it
  // refuses by default. Anyone tempted to "fix" the asymmetry should read that sentence first.
  const review = async (number, { pr = '', text = '' } = {}) => {
    if (!isIssueNumber(number)) return invalidNumber(number)
    const notAnIssue = await refuseIfPullRequest('review', number)
    if (notAnIssue) return notAnIssue
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

  const done = async (number, { pr = '', text = '', force = false } = {}) => {
    if (!isIssueNumber(number)) return invalidNumber(number)
    const notAnIssue = await refuseIfPullRequest('done', number)
    if (notAnIssue) return notAnIssue
    // #28: the read moved ABOVE the write. `done` used to post its **DONE** comment, strip
    // `status:*`, and close without asking who held the issue - measured on pitcairn #1104, where
    // a bystander closed a peer's 11-minute-old live claim and the tool reported success the whole
    // way, which is the #238 duplicate-PR mechanism with the board as the weapon. A refusal that
    // has already commented is not a refusal, so ordering is part of the fix and the arms below
    // assert zero side effects rather than just the returned error.
    const issue = await github.viewIssue(number)
    if (!issue) return { ok: false, error: `Issue #${number} not found` }

    const owner = cleanAgent(ownerOf(issue))
    // two states permit a close without the override: you hold it now, or nobody holds it and you
    // signed its CLAIM at some point. Everything else is someone else's work or unowned work you
    // never picked up, and both were measured happening on pitcairn #1104.
    const allowed =
      owner === cleanCurrent ||
      (owner === '' && hasClaimBy(issue.comments, cleanCurrent))
    if (!allowed && !force) {
      const claim = liveClaims(issue.comments || []).find(
        (c) => c.agent === owner,
      )
      // `at` comes from a comment timestamp a mock caller may omit, and new Date(NaN)
      // .toISOString() throws - a refusal that crashes is a failure path wearing a guard
      const when =
        claim && Number.isFinite(claim.at)
          ? new Date(claim.at).toISOString()
          : 'time unknown'
      return {
        ok: false,
        error: owner
          ? `#${number} is held by agent-${owner} (their **CLAIM** at ${when}) - done closes their work and strips their label, so the board reads free while they are still typing. Claim it, or pass --force if you are a supervisor clearing stale work.`
          : `#${number} is unheld and carries no **CLAIM** by agent-${cleanCurrent}, and 'no owner' is not evidence that it is yours - pitcairn #1104 was exactly a first-person DONE on work the caller had never claimed. Claim it first, or pass --force.`,
      }
    }

    const commentBody =
      `**DONE** | agent: agent-${cleanCurrent} | at: ${now()}` +
      (pr ? ` | pr: #${pr}` : '') +
      (text ? `\n\n${text}` : '')
    await github.commentIssue(number, commentBody)
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
    return {
      ok: true,
      number,
      ...labels,
      owner,
      // which path was taken is part of the record, not a private boolean: a forced close on a
      // peer's issue is the event an auditor looks for afterwards
      forced: force && !allowed,
    }
  }

  const HUB_LABEL = 'hub'

  // #53 review ask (agent-Alpha, merge held by agent-delta): the old sentence always offered
  // `label one issue 'hub'`, which is a command GitHub refuses in pi-agents - that repo's taxonomy
  // has nine stock labels and no `hub`, so `--add-label hub` dies with `could not add label` and
  // creates no artifact. The refusal now reads the taxonomy and points at the exit that works,
  // and it says so when it could not read it: "absent" and "unknown" are different facts, and the
  // second must never be reported as the first.
  const hubLabelAdvice = async () => {
    if (!github.listLabels)
      return `label one issue '${HUB_LABEL}' if that label exists here, or set COORD_HUB`
    let names
    try {
      names = await github.listLabels()
    } catch (err) {
      const why = `${err?.message || err}`.split('\n')[0]
      return `set COORD_HUB=<open issue> (the label taxonomy could not be read: ${why} - so this message cannot claim '${HUB_LABEL}' is absent)`
    }
    if ((names || []).some((n) => labelKey(n) === HUB_LABEL))
      return `label one issue '${HUB_LABEL}' or set COORD_HUB`
    return `set COORD_HUB=<open issue> - this repo's taxonomy has no '${HUB_LABEL}' label to apply, and minting one is a fleet decision: gh label create ${HUB_LABEL}`
  }

  const hubRefusal = (reason) =>
    `hub: ${reason} in ${github.repo || '(no repo resolved)'} - nothing was posted`

  // #71: this used to be a second, private case-fold of the same rule, applied to `issue.labels`
  // directly - which is how the write path and the formatter could answer "is this the hub?"
  // differently for one `HUB` label. The fold lives in `scope.js` now (`labelKey` / `labelKeys` /
  // `hasLabelName`); `labelNames` stays the RAW accessor for the write-back sites
  // (applyLabels' `removeLabels`), where a folded name would be a spelling this repo never minted.
  // Deliberately no verbatim copy of the old expression here: a pin asserts this file contains no
  // case-fold of its own, and a comment that quotes one would make that pin unsatisfiable.
  const labelsOf = (issue) => labelKeys(issue)

  // #53: the target used to be `Number(process.env.COORD_HUB || 4)` - a literal issue
  // number resolved with no label lookup and no existence, kind, or state check, so in a
  // repo that has no hub issue the verb appended fleet reports to whatever object happened
  // to carry that number (in pi-agents: the closed #4 ENOBUFS bug report) and printed
  // success naming a DIFFERENT repo. Resolution is now explicit COORD_HUB, else the single
  // open issue carrying the `hub` label, else a refusal that says which.
  const readHubTarget = async ({ issues } = {}) => {
    const declared = `${process.env.COORD_HUB ?? ''}`.trim()
    // A client that cannot list cannot be verified as having a hub, so the optional call
    // lands on the `no open issue carries the 'hub' label` refusal below rather than a
    // TypeError out of the verb - the safe outcome is still a refusal, never an assumption.
    // #65: `sync` already holds the rows it is about to render, so it passes them in - one read
    // for the board and the hub tail, and both halves are guaranteed to describe the SAME snapshot.
    // Alpha's review note on #67, worth recording where the next reader will see it: when a caller
    // injects `issues` this does NOT re-filter by state, so the name `open` is a promise about the
    // caller, not a guarantee from here. It holds today because `sync` passes rows it read with
    // `{ state: 'open' }` - the same open-only list the write path resolves against - and a faithful
    // double reproduces it (a CLOSED hub-labelled row reaches the no-hub branch, which is how the
    // unfaithful stub that ignored its argument first invented a divergence that did not exist).
    // A future caller passing an all-states list would get a hub that `hub()` would refuse.
    const open =
      issues ?? ((await github.listIssues?.({ state: 'open' })) || [])
    if (declared) {
      const number = Number(declared)
      if (!isIssueNumber(number)) {
        return {
          error: hubRefusal(
            `COORD_HUB=${JSON.stringify(declared)} is not a positive integer issue number`,
          ),
        }
      }
      const listed = open.find((i) => Number(i.number) === number)
      if (!listed) {
        const kind = await github.issueKind(number)
        const why = kind?.isPullRequest
          ? `#${number} is a pull request, not an issue`
          : `#${number} is not an open issue here (closed, or outside the ${open.length} row(s) read)`
        return {
          error: hubRefusal(
            `COORD_HUB=${number} cannot receive a hub line: ${why}`,
          ),
        }
      }
      return { number, via: `COORD_HUB=${number}` }
    }
    const labelled = open.filter((i) => labelsOf(i).includes(HUB_LABEL))
    if (labelled.length === 0) {
      return {
        error: hubRefusal(
          `no open issue carries the '${HUB_LABEL}' label and COORD_HUB is unset - ${(await hubLabelAdvice()).trim()}`,
        ),
      }
    }
    // SKILL.md's Canonical hub invariant: `COORD_HUB` when set, else the LOWEST-numbered
    // open issue labelled `hub`. Ambiguity is not a refusal - a deterministic choice is
    // what makes two agents' runs agree, and the docs' own guidance ("exactly one issue
    // should retain that label") is a cleanup note, not a condition to fail on. The `via`
    // string carries the count so a reader of the record can see the crowding.
    const usable = labelled
      .map((i) => Number(i.number))
      .filter((n) => isIssueNumber(n))
      .sort((a, b) => a - b)
    if (!usable.length) {
      return {
        error: hubRefusal(
          `${labelled.length} issue(s) carry the '${HUB_LABEL}' label but none has a usable issue number`,
        ),
      }
    }
    const via = `the '${HUB_LABEL}' label (lowest of ${usable.length})`
    return { number: usable[0], via }
  }

  const hub = async (text = '') => {
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
    // The target is the LAST guard before the write, so a bad message or a bad stamp
    // never costs a repo read, and a repo with no hub never reaches commentIssue at all.
    const target = await readHubTarget()
    if (target.error) return { ok: false, error: target.error }
    await github.commentIssue(target.number, stamped.text)
    // #53: the success value carries the repo the write actually went through, so the
    // CLI line cannot name a client that was never used (the old `@${target}` did).
    return {
      ok: true,
      hubNumber: target.number,
      repo: github.repo,
      via: target.via,
    }
  }

  const board = async () => {
    const issues = await withFullTimelines(await github.listIssues())
    return formatBoard(issues, cleanCurrent, github.repo)
  }

  const sync = async () => {
    const issues = await withFullTimelines(await github.listIssues())
    // #65: the tail used to resolve its own hub independently of `hub()` - a hard `hubNumber = 4`
    // default that ignored COORD_HUB - so `COORD_HUB=1157 page coord hub "x"` posted to #1157 while
    // the very next `page coord sync` printed `== hub #4 ==`. One resolver now feeds both paths, over
    // the rows this call already read.
    const target = await readHubTarget({ issues })
    return formatSync({
      issues,
      currentAgent: cleanCurrent,
      repo: github.repo,
      hub: target.number ? { number: target.number, via: target.via } : null,
      hubReason: target.error || '',
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
