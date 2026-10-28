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
  done: 'done <issue> [--pr <n>] [message]',
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

module.exports = { USAGE, isIssueNumber, requireIssueNumber, requireMessage }
