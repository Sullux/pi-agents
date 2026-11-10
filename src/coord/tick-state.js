// #94: the fleet's own memory says the Done-when box is "the only gate `coord done` has", and on
// main the literal `[ ]` appeared in ZERO files under `src/` (measured at `ad03d2c`), so no code ever
// read a checkbox. Six issues closed tonight with every box unticked - pitcairn #1207 (0/8), #1201
// (0/5), #1193 (0/4) and pi #90 (0/5), #81 (0/5), #76 (0/5) - because a closing trailer in ANY commit
// of a squashed branch fires the close at merge time, before anyone measures anything. This module is
// the read the guard needs: tick state, scoped to the section that actually means "done".

const DONE_HEADING = /^##\s+done when\b/i
const NEXT_HEADING = /^##\s/
const FENCE = /^\s*(```|~~~)/
const TICKED = /^\s*[-*]\s*\[[xX]\]/
const UNCHECKED = /^\s*[-*]\s*\[ \]/
const ANY_TICK = /^\s*[-*]\s*\[[ xX]\]/
const NUMBERED = /^\s*\d+[.)]\s+\S/
// A bullet that is not a checkbox: `## Done when` written as plain prose items, which #99 ratified as
// a non-gap but which the sweep still has to NAME, or "3 unattested" reads as an empty window.
const BULLET = /^\s*[-*+]\s+(?!\[[ xX]\])/

// Line-anchored, fenced blocks are skipped, and blank lines carry no requirement. Both are load-bearing rather than tidy: pitcairn
// #94's own body quotes `- [ ]` lines to describe what it will pin, and counting a quotation would
// have this guard accuse a fresh issue of being unattested - the same reason `parseScope` anchors
// `^## Files` and skips fences.
const doneWhenLines = (body) => {
  const lines = String(body ?? '').split('\n')
  const start = lines.findIndex((line) => DONE_HEADING.test(line))
  if (start === -1) return { found: false, lines: [] }
  const collected = []
  let insideFence = false
  for (const line of lines.slice(start + 1)) {
    if (!insideFence && NEXT_HEADING.test(line)) break
    if (FENCE.test(line)) insideFence = !insideFence
    else if (!insideFence && line.trim() !== '') collected.push(line)
  }
  return { found: true, lines: collected }
}

// #114: the same fence discipline applied to the WHOLE body. This is the read that turns a Done-when
// heading the classifier cannot parse (`## Done-when`, `## Do when`, `### Done when` - each measured to
// yield `hasSection: false`) from a silent pass into a named shape. The fence skip is load-bearing
// rather than tidy: #94's own body quotes `- [ ]` lines to describe what it will pin, so an unscoped
// count would accuse a well-written issue of carrying orphan boxes.
const unfencedLines = (body) => {
  const collected = []
  let insideFence = false
  for (const line of String(body ?? '').split('\n')) {
    if (FENCE.test(line)) insideFence = !insideFence
    else if (!insideFence && line.trim() !== '') collected.push(line)
  }
  return collected
}

const tickState = (body) => {
  const { found, lines } = doneWhenLines(body)
  const ticked = lines.filter((line) => TICKED.test(line)).length
  const unticked = lines.filter((line) => UNCHECKED.test(line)).length
  const numbered = lines.filter((line) => NUMBERED.test(line)).length
  const boxes = ticked + unticked
  // `attestable` is the difference between an unattested close and a close that could never be
  // attested by ticking: pitcairn #1203 carries six numbered items and pi #87 five, with no checkbox
  // anywhere, and both are legitimately closed - a guard that treated them as missing evidence would
  // simply teach agents to stop writing numbered Done-when lists.
  return {
    hasSection: found,
    ticked,
    unticked,
    boxes,
    numbered,
    bullets: lines.filter((line) => BULLET.test(line)).length,
    // Tick-shaped lines that exist but are invisible to the heading-scoped count. Deliberately zero
    // whenever a Done-when section WAS read: there `boxes` already owns them, and double-counting would
    // make a healthy body look like a bypass.
    orphanBoxes: found
      ? 0
      : unfencedLines(body).filter((line) => ANY_TICK.test(line)).length,
    attestable: boxes > 0,
  }
}

// The single place the vocabulary of "why this closure cannot be attested by ticking a box" is spelled.
// #99 deliberately excluded the box-less shapes from the unattested report - treating them as missing
// evidence "would simply teach agents to stop writing numbered Done-when lists" - and that decision
// stands. What it could not survive was the silence: a report of "3 unattested" drawn from a 15-closure
// window (measured at pi-agents `f3a4e04`: 6 of 15 pitcairn closures, 3 of 8 on pi-agents) is honest
// about what it counted and mute about what was never eligible to appear, so a reader cannot tell
// "nothing was missing" from "40% of the window was dropped by the filter". Naming is the fix.
const closureShape = (state) => {
  if (state.attestable) return 'checkboxes'
  if (!state.hasSection)
    return state.orphanBoxes > 0 ? 'unreadable-heading' : 'no-when-section'
  if (state.numbered > 0) return 'numbered'
  if (state.bullets > 0) return 'plain-bullets'
  return 'empty-section'
}

// The sentence a refusal carries, and the marker a permitted close records. Kept here so the shape is
// pinned once: an escape hatch nobody can grep for is an escape hatch agents will not find.
const unattestedNote = (state) =>
  state.hasSection || state.orphanBoxes === 0
    ? `unattested: ${state.unticked}/${state.boxes}`
    : `unattested: ${state.unticked}/${state.boxes} + ${state.orphanBoxes} tick line(s) no Done-when heading could attribute (#114)`

module.exports = {
  tickState,
  doneWhenLines,
  unfencedLines,
  closureShape,
  unattestedNote,
}
