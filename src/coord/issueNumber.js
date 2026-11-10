// One source for "what a mutating coord verb takes" (pi-agents#13).
//
// BOTH layers need it: the CLI refuses before it does anything else, and the
// coord service refuses before any code path can reach a `gh` spawn. Keeping
// the arity table next to the validity rule is what stops a usage line from
// drifting away from the guard that prints it - which is exactly how #13's
// stack trace ended up naming nothing about the argument it wanted.
//
// `Number(undefined)` is `NaN`, and `NaN` used to travel all the way to
// `gh issue comment NaN --body **STATUS** ... | at: <epoch>`, which reads like a
// quoting accident in the caller's own command rather than a missing positional.
const USAGE = {
  claim: 'claim <issue>',
  release: 'release <issue> [--reason "<why>"]',
  status: 'status <issue> "<message>"',
  review: 'review <issue> --pr <n> "<verdict>"',
  done: 'done <issue> [--pr <n>] [message] [--force]',
}

// The mutating verbs all address one issue, so one rule covers all five: a real,
// positive integer. `Number.isInteger` refuses NaN, Infinity, and 13.5; the
// `> 0` refuses `0`, which `gh` would otherwise happily send to a 404.
const isIssueNumber = (value) => Number.isInteger(value) && value > 0

const missing = (raw) => raw === undefined || `${raw}`.trim() === ''

const usageLine = (sub, problem, raw) =>
  `Error: coord ${sub}: ${problem}` +
  (missing(raw) ? '' : ` ${JSON.stringify(`${raw}`)}`) +
  `. Usage: page coord ${USAGE[sub] || sub}.` +
  ' For the whole queue use: page coord board'

// Returns `{ value }` when the positional really is an issue number, otherwise
// `{ error }` - so the caller can print and exit 1 without throwing. Checked on
// the PARSED number, not on raw argv, because the bug was a parsed value that
// stayed in the code path after becoming meaningless.
const requireIssueNumber = (sub, raw) => {
  const parsed = Number(raw)
  return isIssueNumber(parsed)
    ? { value: parsed }
    : {
        error: usageLine(
          sub,
          missing(raw) ? 'missing issue number' : 'invalid issue number',
          raw,
        ),
      }
}

// `status`/`review` post a protocol line whose whole content is the message, so a
// missing one is the same class of accident: a write against the shared board
// that carries no information. No caller in the fleet omits it (scanned before
// adding this), and the arity in USAGE is the contract being enforced.
const requireMessage = (sub, text) =>
  typeof text === 'string' && text.trim()
    ? { value: text }
    : {
        error: usageLine(
          sub,
          'missing message (the text is the comment)',
          undefined,
        ),
      }

// #30: a PR body that closes work usually says so, and the number is cheap to read out. Deliberately
// a CANDIDATE list printed for a human to re-run with - the guard never mutates the issue it found
// here, because guessing which issue a PR closes and writing to it is the silent reinterpretation this
// family keeps rejecting (#30's own Notes). Covers the keywords GitHub parses, and the fleet's
// `Refs #N` form too.
const CLOSING_KEYWORD_RE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\s*:?\s*#(\d+)/gi

const linkedIssues = (body = '') => {
  const seen = []
  for (const match of `${body}`.matchAll(CLOSING_KEYWORD_RE)) {
    if (!seen.includes(match[1])) seen.push(match[1])
  }
  return seen
}

// Names the offending number, says what it is, and prints the candidate - which is exactly what the
// measured incident needed: `page coord review 1138 --pr 1138` printed `Moved #1138 to in-review`.
const pullRequestRefusal = (sub, number, kind = {}) => {
  const linked = linkedIssues(kind.body)
  const title = `${kind.title || ''}`.trim()
  return (
    `Error: coord ${sub}: #${number} is a PULL REQUEST${title ? ` ("${title}")` : ''}, not an issue - ` +
    'coord verbs address the board, and GitHub resolves either number from the same sequence, so this ' +
    'write would post a protocol line onto a tree. Nothing was written. ' +
    (linked.length
      ? `It looks like you meant issue ${linked.map((n) => `#${n}`).join(', ')} (read from the PR's own closing line). `
      : 'No linked issue is resolvable from the PR body. ') +
    `Usage: page coord ${USAGE[sub] || sub}.`
  )
}

// #106: the STATE half of #30's KIND half, born from pitcairn#1218. The issue was auto-closed by
// PR #1225's Closes trailer at 03:27:28Z; at 03:28:21Z `page coord review 1218 --pr 1225` rc=0'd,
// printed `Moved #1218 to in-review`, posted a **REVIEW** onto the CLOSED issue, and STAMPED
// `status:in-review` back onto an artifact already COMPLETED - putting finished work on the board
// as live. The kind guard shipped for exactly that class could not see it, because the artifact
// was an issue; it just was not an OPEN one. All five mutating verbs refuse CLOSED uniformly and
// `--force` does NOT override: a supervisor who wants a closed artifact restated reopens it
// deliberately, so board and timeline agree on what work is live. Post-merge attestation has its
// own surface - the PR thread - which is where this refusal sends the reader.
const closedRefusal = (sub, number, kind = {}) => {
  const reason = `${kind.stateReason || ''}`.trim()
  return (
    `Error: coord ${sub}: #${number} is CLOSED${reason ? ` (${reason})` : ''}, not open - ` +
    'coord verbs address the live board, and a protocol line written onto a closed artifact puts ' +
    'finished work back on it as live. Nothing was written. ' +
    'If it merged, attest the shipped tree with `gh pr comment` on the PR thread; if you meant to ' +
    'resume it, run `gh issue reopen` deliberately and re-run the verb. ' +
    `Usage: page coord ${USAGE[sub] || sub}.`
  )
}

module.exports = {
  USAGE,
  isIssueNumber,
  requireIssueNumber,
  requireMessage,
  linkedIssues,
  pullRequestRefusal,
  closedRefusal,
}
