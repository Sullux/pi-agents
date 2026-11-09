const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { tickState, doneWhenLines, unattestedNote } = require('../../src/coord/tick-state')

// #94: the guard these pins protect exists because SIX issues closed with every box unticked
// (pitcairn #1207 0/8, #1201 0/5, #1193 0/4; pi #90, #81, #76 each 0/5), and the read they encode is
// the half that was missing: nobody had ever looked at a checkbox. A change here silently re-arms or
// silently disarms that gate, so each shape the fleet actually writes gets its own arm.
describe('tick-state (the read the #94 close guard depends on)', () => {
  const wrap = (section) => `## Goal\nsome prose\n\n## Done when\n${section}\n\n## Files\nsrc/foo.js\n`

  it('counts a mixed section by state, not by presence', () => {
    const state = tickState(wrap('- [x] measured\n- [ ] not measured\n- [ ] also not\n'))
    assert.deepEqual(state, {
      hasSection: true,
      ticked: 1,
      unticked: 2,
      boxes: 3,
      numbered: 0,
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
    assert.deepEqual([state.ticked, state.unticked, state.attestable], [0, 2, true])
  })

  it('treats a missing Done-when section as nothing to police, not as a failure', () => {
    const state = tickState('## Goal\nonly a goal\n\n## Files\nsrc/foo.js\n')
    assert.equal(state.hasSection, false)
    assert.equal(state.attestable, false)
    // an absent body is the same fact, and `done` must not crash on a mock that omits it
    assert.equal(tickState(undefined).attestable, false)
  })

  it('does NOT call a numbered Done-when unattested (pitcairn #1203 and pi #87 are written this way)', () => {
    const numbered = tickState('## Done when\n1. first item\n2. second item\n3. third item\n')
    assert.equal(numbered.attestable, false, 'a numbered list has no tick mechanism to attest with')
    assert.equal(numbered.unticked, 0)
    assert.equal(numbered.numbered, 3, 'and it still reports the population, so the count is visible')
  })

  // The load-bearing pair: a quoted checklist inside a code fence is documentation, and this is the
  // arm that proves the fence rule is real rather than decorative - pitcairn #94's own body quotes
  // `- [ ]` lines, so an unguarded read would accuse the issue that filed the guard.
  it('skips a fenced block inside the section, and counts the same lines unwrapped', () => {
    const quoted = wrap('```text\n- [ ] an example, not a requirement\n```\n')
    assert.equal(tickState(quoted).attestable, false, 'a quoted example must not block a close')
    const real = wrap('- [ ] an example, not a requirement\n')
    assert.equal(tickState(real).unticked, 1, 'the identical line at real depth DOES count')
    assert.deepEqual(doneWhenLines(quoted).lines, [], 'and the section read shows the fence dropped')
  })

  it('ends the section at the next heading, so a later checklist cannot be mistaken for it', () => {
    const body = '## Done when\n- [x] the real one\n\n## Notes\n- [ ] a note, not a gate\n'
    const state = tickState(body)
    assert.deepEqual([state.ticked, state.unticked], [1, 0])
  })

  it('anchors the heading at line start, so prose that quotes it does not open the section', () => {
    // mirrors parseScope's line anchoring: a mid-line mention is a sentence, not a heading
    const state = tickState('The template says ## Done when and then lists nothing\n')
    assert.equal(state.hasSection, false)
  })

  it('accepts either bullet marker and either bracket case, because the fleet writes both', () => {
    const state = tickState('## Done when\n* [X] star capital\n- [x] dash lower\n')
    assert.deepEqual([state.ticked, state.unticked], [2, 0])
  })
})
