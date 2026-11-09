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
const NUMBERED = /^\s*\d+[.)]\s+\S/

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

const tickState = (body) => {
  const { found, lines } = doneWhenLines(body)
  const ticked = lines.filter((line) => TICKED.test(line)).length
  const unticked = lines.filter((line) => UNCHECKED.test(line)).length
  const numbered = lines.filter((line) => NUMBERED.test(line)).length
  // `attestable` is the difference between an unattested close and a close that could never be
  // attested by ticking: pitcairn #1203 carries six numbered items and pi #87 five, with no checkbox
  // anywhere, and both are legitimately closed - a guard that treated them as missing evidence would
  // simply teach agents to stop writing numbered Done-when lists.
  return {
    hasSection: found,
    ticked,
    unticked,
    boxes: ticked + unticked,
    numbered,
    attestable: ticked + unticked > 0,
  }
}

// The sentence a refusal carries, and the marker a permitted close records. Kept here so the shape is
// pinned once: an escape hatch nobody can grep for is an escape hatch agents will not find.
const unattestedNote = (state) =>
  `unattested: ${state.unticked}/${state.boxes}`

module.exports = { tickState, doneWhenLines, unattestedNote }
