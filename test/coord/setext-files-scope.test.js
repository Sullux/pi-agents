const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

// pi-agents #26: `parseScope` anchored the Files section on `^## Files`, so an issue written with
// SETEXT headings (`Files` + a line of dashes) declared no scope at all and `page coord claim N`
// refused it with "declares no Files scope" for EVERY agent - measured live on pitcairn #1059, a p1
// that sat visibly unclaimed on the board while being structurally unclaimable. The same anchor gap
// cuts the other way too: an ATX `## Files` followed by a setext `Notes` leaked that section's prose
// as paths, so one format could both under-declare and OVER-declare.
const { parseScope, filesSectionDiagnosis } = require('../../src/coord/scope')
const { CoordService } = require('../../src/coord')

const ATX = [
  '## Goal',
  'fix the parser',
  '',
  '## Files',
  'src/coord/scope.js',
  'test/coord/setext-files-scope.test.js',
  '',
  '## Notes',
  'prose that must never become a path',
].join('\n')

const SETEXT = [
  'Goal',
  '====',
  'fix the parser',
  '',
  'Files',
  '-----',
  'src/coord/scope.js',
  'test/coord/setext-files-scope.test.js',
  '',
  'Notes',
  '-----',
  'prose that must never become a path',
].join('\n')

const MIXED = [
  '## Goal',
  'fix the parser',
  '',
  'Files',
  '-----',
  'src/coord/scope.js',
  'test/coord/setext-files-scope.test.js',
  '',
  '## Notes',
  'prose',
].join('\n')

// the over-declaration shape the issue measured: ATX opener, setext follower. Pre-fix this returned
// the declared path PLUS `Notes`, a `-----` underline and a prose token - three junk paths that make
// the issue collide with unrelated work.
const ATX_FILES_WITH_SETEXT_NOTES = [
  '## Files',
  'src/a.js',
  '',
  'Notes',
  '-----',
  'y',
].join('\n')

describe('#26 parseScope reads a setext Files section', () => {
  it('the setext form declares exactly the same scope as the ATX form', () => {
    assert.deepEqual(
      parseScope(SETEXT),
      ['src/coord/scope.js', 'test/coord/setext-files-scope.test.js'],
      `got: ${JSON.stringify(parseScope(SETEXT))}`,
    )
    assert.deepEqual(
      parseScope(SETEXT),
      parseScope(ATX),
      'the two heading styles must agree, or the board depends on how the author typed it',
    )
  })

  it('the underline is never emitted as a path (box 2)', () => {
    for (const body of [SETEXT, MIXED, ATX_FILES_WITH_SETEXT_NOTES]) {
      for (const path of parseScope(body)) {
        assert.doesNotMatch(
          path,
          /^[-=]{3,}$/,
          `a setext underline reached the scope list as a path: ${JSON.stringify(path)} in ${JSON.stringify(parseScope(body))}`,
        )
      }
    }
    // a level-1 setext underline (===) is the same hazard, and `Goal` above it is prose
    assert.deepEqual(parseScope(['Files', '=====', 'src/a.js'].join('\n')), [
      'src/a.js',
    ])
  })

  it('a body that MIXES styles parses the same scope as a uniform one (box 3)', () => {
    assert.deepEqual(parseScope(MIXED), parseScope(ATX))
    assert.deepEqual(parseScope(MIXED), parseScope(SETEXT))
  })

  it('a setext heading TERMINATES an ATX Files section (box 4, the over-declaration half)', () => {
    const paths = parseScope(ATX_FILES_WITH_SETEXT_NOTES)
    assert.deepEqual(paths, ['src/a.js'], `got: ${JSON.stringify(paths)}`)
    for (const junk of ['Notes', '-----', 'y']) {
      assert.ok(
        !paths.includes(junk),
        `${JSON.stringify(junk)} leaked out of the following section into scope`,
      )
    }
  })

  it('the section-terminator rule holds in BOTH directions', () => {
    // setext Files then ATX Notes: the ATX heading must close it
    assert.deepEqual(
      parseScope(
        ['Files', '-----', 'src/a.js', '', '## Notes', 'prose'].join('\n'),
      ),
      ['src/a.js'],
    )
    // setext Files then setext Notes: same answer
    assert.deepEqual(
      parseScope(
        ['Files', '-----', 'src/a.js', '', 'Notes', '-----', 'prose'].join(
          '\n',
        ),
      ),
      ['src/a.js'],
    )
    // no terminator at all: the section runs to end of body
    assert.deepEqual(
      parseScope(['Files', '-----', 'src/a.js', 'src/b.js'].join('\n')),
      ['src/a.js', 'src/b.js'],
    )
  })

  it('a thematic break after a blank line is NOT a heading, so it cannot close the section', () => {
    // CommonMark: an underline must be immediately adjacent to its heading text. A `----` on its
    // own between two path lines is a rule, and a parser that read it as a heading would silently
    // drop every path below it.
    const body = ['## Files', 'src/a.js', '', '----', '', 'src/b.js'].join('\n')
    assert.deepEqual(parseScope(body), ['src/a.js', 'src/b.js'])
  })

  it('two consecutive rules do not fake a setext heading and drop the paths below them', () => {
    // the guard this arm exists for: `isSetextHeading` refuses a line that is ITSELF an underline,
    // because otherwise the first rule reads as heading text, the second as its underline, and the
    // section closes mid-body - which is #26's under-declaration failure wearing a new hat
    assert.deepEqual(
      parseScope(
        ['## Files', 'src/a.js', '', '-----', '-----', 'src/b.js'].join('\n'),
      ),
      ['src/a.js', 'src/b.js'],
    )
    assert.deepEqual(
      parseScope(
        ['Files', '-----', 'src/a.js', '', '-----', '-----', 'src/b.js'].join(
          '\n',
        ),
      ),
      ['src/a.js', 'src/b.js'],
      'and the setext opener must survive it too',
    )
  })

  it('a fenced example of a setext Files heading is still skipped (#816 is not widened)', () => {
    const body = [
      '## Files',
      'src/a.js',
      '',
      '## Notes',
      '```',
      'Files',
      '-----',
      'not/a/path.js',
      '```',
    ].join('\n')
    assert.deepEqual(parseScope(body), ['src/a.js'])
  })

  it('decorated path lines normalize under a setext heading too (#820)', () => {
    const body = [
      'Files',
      '-----',
      '- `src/a.js`',
      '- `src/b.js`',
      '',
      'Notes',
      '-----',
      'prose',
    ].join('\n')
    assert.deepEqual(parseScope(body), ['src/a.js', 'src/b.js'])
  })

  it('a setext heading may carry an annotation and still open the section', () => {
    assert.deepEqual(
      parseScope(['Files (paths to touch)', '-----', 'src/a.js'].join('\n')),
      ['src/a.js'],
    )
    // and a look-alike word must NOT open it, the way `## Filesx` would
    assert.deepEqual(
      parseScope(['Filesystem', '-----', 'src/a.js'].join('\n')),
      [],
    )
  })
})

describe('#26 filesSectionDiagnosis names the real reason (box 5)', () => {
  it('the three states are distinguishable, in the parser a caller actually runs', () => {
    assert.equal(
      filesSectionDiagnosis(ATX),
      'the Files section parsed fine',
      'a good body must not be accused',
    )
    assert.equal(
      filesSectionDiagnosis('## Goal\nnothing here at all'),
      'no Files heading in either form (## Files, or Files followed by ----)',
    )
    assert.equal(
      filesSectionDiagnosis(['## Files', '', '## Notes', 'prose'].join('\n')),
      'a Files heading exists but its section names no paths',
      'this is the shape that used to be reported as a missing section',
    )
    assert.equal(
      filesSectionDiagnosis(
        ['Files', '-----', '', 'Notes', '-----'].join('\n'),
      ),
      'a Files heading exists but its section names no paths',
      'and the same diagnosis must hold for the setext form',
    )
  })

  it('a Files heading inside a fence is not a Files heading', () => {
    assert.equal(
      filesSectionDiagnosis(
        ['## Notes', '```', '## Files', 'src/a.js', '```'].join('\n'),
      ),
      'no Files heading in either form (## Files, or Files followed by ----)',
    )
  })
})

describe('#26 the claim path reports the reason, not just the refusal', () => {
  const serviceWith = (body) => {
    const calls = []
    const coord = CoordService({
      github: {
        viewIssue: async (number) => ({
          number,
          title: '#26 fixture',
          body,
          labels: [],
          comments: [],
        }),
        listIssues: async () => [],
        commentIssue: async () => calls.push('comment'),
        editIssue: async () => calls.push('edit'),
        closeIssue: async () => calls.push('close'),
      },
      agent: 'agent-delta',
      now: () => 1750000000000,
    })
    return { coord, calls }
  }

  it('keeps the pinned phrase AND adds the diagnosis', async () => {
    const { coord, calls } = serviceWith('## Goal\nno section here')
    const res = await coord.claim(700)
    assert.equal(res.ok, false)
    // four existing arms match this substring; a reworded error must not break them
    assert.match(res.error, /#700 declares no Files scope/)
    assert.match(
      res.error,
      /no Files heading in either form/,
      'the catch-all is the defect: it sent authors hunting for a section that was there',
    )
    assert.deepEqual(calls, [], 'a refused claim still writes nothing')
  })

  it('distinguishes an empty Files section from a missing one', async () => {
    const { coord } = serviceWith(
      ['## Files', '', '## Notes', 'prose'].join('\n'),
    )
    const res = await coord.claim(700)
    assert.equal(res.ok, false)
    assert.match(
      res.error,
      /a Files heading exists but its section names no paths/,
    )
  })

  it('a setext-bodied issue is claimable, which is the whole point', async () => {
    const { coord, calls } = serviceWith(SETEXT)
    const res = await coord.claim(700)
    assert.equal(res.ok, true, `pre-fix this refused with: ${res.error}`)
    assert.deepEqual(calls, ['comment', 'edit'])
  })
})
