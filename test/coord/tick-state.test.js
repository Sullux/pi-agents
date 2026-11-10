const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const {
  tickState,
  doneWhenLines,
  closureShape,
  unattestedNote,
} = require('../../src/coord/tick-state')

// #94: the guard these pins protect exists because SIX issues closed with every box unticked
// (pitcairn #1207 0/8, #1201 0/5, #1193 0/4; pi #90, #81, #76 each 0/5), and the read they encode is
// the half that was missing: nobody had ever looked at a checkbox. A change here silently re-arms or
// silently disarms that gate, so each shape the fleet actually writes gets its own arm.
describe('tick-state (the read the #94 close guard depends on)', () => {
  const wrap = (section) =>
    `## Goal\nsome prose\n\n## Done when\n${section}\n\n## Files\nsrc/foo.js\n`

  it('counts a mixed section by state, not by presence', () => {
    const state = tickState(
      wrap('- [x] measured\n- [ ] not measured\n- [ ] also not\n'),
    )
    assert.deepEqual(state, {
      hasSection: true,
      ticked: 1,
      unticked: 2,
      boxes: 3,
      numbered: 0,
      bullets: 0,
      orphanBoxes: 0,
      attestable: true,
    })
    assert.equal(unattestedNote(state), 'unattested: 2/3')
  })

  it('reports a fully ticked section as attested', () => {
    const state = tickState(wrap('- [x] one\n- [x] two\n'))
    assert.equal(state.unticked, 0)
    assert.equal(state.attestable, true)
  })

  it('reports a section with nothing ticked as fully unattested', () => {
    const state = tickState(wrap('- [ ] one\n- [ ] two\n'))
    assert.deepEqual(
      [state.ticked, state.unticked, state.attestable],
      [0, 2, true],
    )
  })

  it('treats a missing Done-when section as nothing to police, not as a failure', () => {
    const state = tickState('## Goal\nonly a goal\n\n## Files\nsrc/foo.js\n')
    assert.equal(state.hasSection, false)
    assert.equal(state.attestable, false)
    // an absent body is the same fact, and `done` must not crash on a mock that omits it
    assert.equal(tickState(undefined).attestable, false)
  })

  it('does NOT call a numbered Done-when unattested (pitcairn #1203 and pi #87 are written this way)', () => {
    const numbered = tickState(
      '## Done when\n1. first item\n2. second item\n3. third item\n',
    )
    assert.equal(
      numbered.attestable,
      false,
      'a numbered list has no tick mechanism to attest with',
    )
    assert.equal(numbered.unticked, 0)
    assert.equal(
      numbered.numbered,
      3,
      'and it still reports the population, so the count is visible',
    )
  })

  // The load-bearing pair: a quoted checklist inside a code fence is documentation, and this is the
  // arm that proves the fence rule is real rather than decorative - pitcairn #94's own body quotes
  // `- [ ]` lines, so an unguarded read would accuse the issue that filed the guard.
  it('skips a fenced block inside the section, and counts the same lines unwrapped', () => {
    const quoted = wrap('```text\n- [ ] an example, not a requirement\n```\n')
    assert.equal(
      tickState(quoted).attestable,
      false,
      'a quoted example must not block a close',
    )
    const real = wrap('- [ ] an example, not a requirement\n')
    assert.equal(
      tickState(real).unticked,
      1,
      'the identical line at real depth DOES count',
    )
    assert.deepEqual(
      doneWhenLines(quoted).lines,
      [],
      'and the section read shows the fence dropped',
    )
  })

  it('ends the section at the next heading, so a later checklist cannot be mistaken for it', () => {
    const body =
      '## Done when\n- [x] the real one\n\n## Notes\n- [ ] a note, not a gate\n'
    const state = tickState(body)
    assert.deepEqual([state.ticked, state.unticked], [1, 0])
  })

  it('anchors the heading at line start, so prose that quotes it does not open the section', () => {
    // mirrors parseScope's line anchoring: a mid-line mention is a sentence, not a heading
    const state = tickState(
      'The template says ## Done when and then lists nothing\n',
    )
    assert.equal(state.hasSection, false)
  })

  it('accepts either bullet marker and either bracket case, because the fleet writes both', () => {
    const state = tickState(
      '## Done when\n* [X] star capital\n- [x] dash lower\n',
    )
    assert.deepEqual([state.ticked, state.unticked], [2, 0])
  })
})

// #114: `attestable: false` was a single silent bucket covering four different facts, and the one that
// matters most (a Done-when heading the regex cannot read) was indistinguishable from an issue that
// simply has no acceptance criteria. Each shape now has a name, so the sweep can report the population
// it excluded instead of dropping it.
it('names each box-less closure shape, and no two of them collapse together', () => {
  const shapes = {
    checkboxes: tickState('## Done when\n- [ ] a\n'),
    numbered: tickState('## Done when\n1. a\n2. b\n'),
    plainBullets: tickState('## Done when\n- first\n- second\n'),
    emptySection: tickState('## Done when\n'),
    noWhenSection: tickState('## Goal\nonly a goal\n'),
    unreadableHeading: tickState('## Done-when\n- [ ] a\n- [ ] b\n'),
  }
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(shapes).map(([k, s]) => [k, closureShape(s)]),
    ),
    {
      checkboxes: 'checkboxes',
      numbered: 'numbered',
      plainBullets: 'plain-bullets',
      emptySection: 'empty-section',
      noWhenSection: 'no-when-section',
      unreadableHeading: 'unreadable-heading',
    },
  )
  const values = Object.values(shapes).map(closureShape)
  assert.equal(
    new Set(values).size,
    values.length,
    `shapes collapsed: ${values.join(', ')}`,
  )
  assert.equal(
    shapes.checkboxes.attestable,
    true,
    'only the checkbox shape is attestable, and that is #99 bar',
  )
  assert.deepEqual(
    Object.values(shapes)
      .filter((s) => !s.attestable)
      .map(closureShape)
      .sort(),
    [
      'empty-section',
      'no-when-section',
      'numbered',
      'plain-bullets',
      'unreadable-heading',
    ],
    'the excluded population must be enumerable, not just absent',
  )
})

// The bypass this issue exists to close: the guard condition is `attestable && unticked > 0`, so one
// character of heading spelling removes four real boxes from the gate, and the DONE line then rendered
// `unattested: 0/0` - a positive claim of zero missing evidence about a body that has four.
it('a Done-when heading the regex cannot parse reports its boxes as orphans, not as zero', () => {
  const state = tickState(
    '## Done-when\n- [ ] measured lane\n- [ ] discrimination\n- [ ] head authority\n- [ ] hub ping\n',
  )
  assert.equal(
    state.hasSection,
    false,
    'the shipped regex genuinely cannot read this',
  )
  assert.equal(state.boxes, 0)
  assert.equal(state.attestable, false)
  assert.equal(
    state.orphanBoxes,
    4,
    'four tick-shaped lines exist and the heading-scoped count cannot see them',
  )
  assert.equal(closureShape(state), 'unreadable-heading')
  const note = unattestedNote(state)
  assert.ok(
    !/^unattested: 0\/0$/.test(note),
    `the note still attests a clean close: ${note}`,
  )
  assert.match(note, /4 tick line\(s\)/)
  assert.equal(
    // the normal case must render byte-identically, or this change rewrites the DONE line every
    // existing pin already asserts
    unattestedNote(tickState('## Done when\n- [x] a\n- [ ] b\n')),
    'unattested: 1/2',
  )
})

it('the orphan count skips a fenced quotation, so #94 own body is not accused', () => {
  const quoted =
    '## Goal\nx\n\n```text\n- [ ] an example, not a requirement\n```\n'
  const quotedState = tickState(quoted)
  assert.equal(quotedState.orphanBoxes, 0, 'a fenced example is documentation')
  assert.equal(closureShape(quotedState), 'no-when-section')
  // positive control in the same arm: the identical line at real depth must count, or the fence rule
  // above is satisfied by a scanner that sees nothing at all
  const real = tickState('## Goal\nx\n\n- [ ] an example, not a requirement\n')
  assert.equal(
    real.orphanBoxes,
    1,
    'the same bytes outside a fence DO register - the fence arm cannot be vacuous',
  )
  assert.equal(closureShape(real), 'unreadable-heading')
})
