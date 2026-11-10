// #137: the scope gate and the board must answer from ONE reader. Before this, `statusOf` was
// label-only in the gate while the board fell back to the protocol timeline, so in a repo with no
// `status:*` labels (pi-agents carries none) #863's soft rule was inert: a label-less issue whose
// timeline said `in-review` was REFUSED by the gate (`collidingStatus=unclaimed`) while the board
// printed `in-review` beside it, and - the worse half - a label-less CLAIMed issue got the #76
// "no claim yet" warning, i.e. the gate called a held issue free.
//
// Each arm asserts BOTH readings in one place (board cell + gate verdict) so a future edit that
// re-separates the readers reddens here instead of producing another warn-in-one-repo,
// refuse-in-the-other session. FIRED-PROOF note for discrimination (Done-when box 4): reverting
// the gate to label-only `statusOf` reddens arms 1 and 2 (and only those); making the guard
// soft-for-everything reddens arm 3. Markers are unique tokens `PX137*`, asserted present after
// mutation and absent after restore - never `# PROBE`, which is a live string in this corpus.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  checkScopeCollision,
  statusCell,
  statusOf,
} = require('../../src/coord/scope')

const issueWith = (number, commentBodies, labels = []) => ({
  number,
  labels,
  body: '## Files\nsrc/x.js',
  comments: commentBodies.map((body) => ({ body })),
})

const TARGET = { number: 1, body: '## Files\nsrc/x.js' }

test('#137 arm 1 PX137review: a label-less timeline that says in-review WARNS and agrees with the board cell', () => {
  const overlap = issueWith(2, [
    '**REVIEW** | agent: agent-delta | human: @Sullux',
  ])
  // non-vacuity floor: the label-only reader must DISAGREE with the shared reader here, or this
  // arm measures nothing - it would pass on the old code too.
  assert.equal(
    statusOf(overlap),
    'unclaimed',
    'floor: labels-only still reads unclaimed',
  )
  assert.equal(
    statusCell(overlap),
    'in-review',
    'shared reader derives the timeline',
  )
  const gate = checkScopeCollision(['src/x.js'], [overlap], 'charlie', TARGET)
  assert.equal(
    gate.hasCollision,
    false,
    'in-review is soft - a finished, unmerged lane must not fence files',
  )
  assert.equal(gate.warnings.length, 1)
  assert.equal(
    gate.warnings[0].status,
    'in-review',
    'the warning carries the DERIVED status, not the label default',
  )
})

test('#137 arm 2 PX137board: board cell and gate verdict on one object cannot disagree', () => {
  const held = issueWith(2, ['**CLAIM** | agent: agent-delta'])
  const { formatBoard } = require('../../src/coord/formatters')
  const board = formatBoard([held, TARGET], 'charlie', 'Sullux/pi-agents')
  assert.match(
    board,
    /#2\s+claimed/,
    'the board cell says claimed for the CLAIM timeline',
  )
  const gate = checkScopeCollision(['src/x.js'], [held], 'charlie', TARGET)
  assert.equal(
    gate.collidingStatus,
    'claimed',
    'the gate says the same word the board printed',
  )
})

test('#137 arm 3 PX137claim: a label-less CLAIM is a hard refusal - narrowing the soft class did not open the gate', () => {
  const held = issueWith(2, ['**CLAIM** | agent: agent-delta'])
  const gate = checkScopeCollision(['src/x.js'], [held], 'charlie', TARGET)
  assert.equal(
    gate.hasCollision,
    true,
    'a live edit by another agent refuses, timeline-derived or not',
  )
  assert.equal(gate.collidingAgent, 'delta')
  assert.equal(
    gate.warnings.find((w) => w.status === 'unclaimed'),
    undefined,
    'the old label-default warning must be gone - that misread called a held issue free',
  )
})

test('#137 arm 4 PX137labels: a repo that DOES label is untouched by the shared reader', () => {
  // pitcairn's world: status:in-review label present. The label short-circuits, so behavior is
  // byte-identical to pre-#137 - this arm is what keeps the fix from becoming a board change.
  const labelled = issueWith(2, [], [{ name: 'status:in-review' }])
  assert.equal(statusCell(labelled), 'in-review')
  const gate = checkScopeCollision(['src/x.js'], [labelled], 'charlie', TARGET)
  assert.equal(gate.hasCollision, false)
  assert.equal(gate.warnings[0].status, 'in-review')
})
