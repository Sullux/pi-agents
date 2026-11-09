const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

// pi-agents #81: `NOT_A_PATH` filtered `_(`, `#`, underline tokens, `split:` lines and comment
// fragments, but not `>` - so a block-quoted intent note inside the `## Files` section was emitted
// as a scope PATH. The live witness is pitcairn #1182, whose Files section measured through this
// parser as:
//   ["AGENTS.md", "> Box 1 stays unticked on purpose: it is a claim about main, and this branch is not merged"]
// i.e. two declared paths, one of them a sentence, and `page coord board` rendered both in the
// FILES column. Nothing errored, which is what makes it worth pinning: the phantom can never
// produce a FALSE collision (the gate compares whole strings, and no file is named that), so the
// only way it surfaces is an author or auditor counting declared scope and getting a number that
// includes prose - the exact failure the pitcairn memory line about fencing deferred paths warns
// about, arriving through the syntax that looks safest to write.
const { parseScope, filesSectionDiagnosis } = require('../../src/coord/scope')

// The section must stay OPEN after a dropped note: filtering the token while ending the section
// would trade an over-declaration for an under-declaration, which is the #26 bug in reverse.
const PATHS_AFTER_NOTE = [
  '## Goal',
  'fix the parser',
  '',
  '## Files',
  '> this note comes first, and must not swallow the paths below it',
  'src/coord/scope.js',
  'test/coord/blockquote-files-scope.test.js',
  '',
  '## Notes',
  'prose that was never in scope',
].join('\n')

const NOTE_AFTER_PATHS = [
  '## Files',
  'AGENTS.md',
  '',
  '> Box 1 stays unticked on purpose: it is a claim about main, and this branch is not merged yet.',
  '',
  '## Depends on',
  'nothing',
].join('\n')

const SETEXT = [
  'Files',
  '=====',
  'src/coord/scope.js',
  '> quoted note under a setext heading, same filter, different opener',
  'test/coord/blockquote-files-scope.test.js',
].join('\n')

describe('#81 a block-quoted line in the Files section is a note, not a path', () => {
  it('returns exactly the real path for the pitcairn #1182 shape', () => {
    const paths = parseScope(NOTE_AFTER_PATHS)
    assert.deepEqual(paths, ['AGENTS.md'])
    assert.equal(paths.length, 1, 'a sentence is not a declared path')
  })

  it('keeps the section open, so paths AFTER a leading note are still collected', () => {
    assert.deepEqual(parseScope(PATHS_AFTER_NOTE), [
      'src/coord/scope.js',
      'test/coord/blockquote-files-scope.test.js',
    ])
  })

  it('treats a setext-headed Files section identically', () => {
    assert.deepEqual(parseScope(SETEXT), [
      'src/coord/scope.js',
      'test/coord/blockquote-files-scope.test.js',
    ])
  })

  it('drops a nested quote and a padded quote, because the entry is trimmed first', () => {
    const body = [
      '## Files',
      '>> deeply quoted note',
      '   > indented note',
      'src/a.js',
    ].join('\n')
    assert.deepEqual(parseScope(body), ['src/a.js'])
  })

  it('drops a QUOTED path too: `> src/a.js` documents a path, it does not declare one', () => {
    assert.deepEqual(
      parseScope(['## Files', '> src/a.js', 'src/b.js'].join('\n')),
      ['src/b.js'],
    )
  })

  it('is a LINE-PREFIX rule, not a character rule: a `>` inside a path survives', () => {
    assert.deepEqual(parseScope(['## Files', 'src/a>b.js'].join('\n')), [
      'src/a>b.js',
    ])
  })

  it('leaves the no-paths diagnosis honest when a section holds ONLY a note', () => {
    const body = ['## Files', '> nothing but a note here'].join('\n')
    assert.deepEqual(parseScope(body), [])
    assert.equal(
      filesSectionDiagnosis(body),
      'a Files heading exists but its section names no paths',
      'the diagnostic must name the real failure, not claim the section is missing',
    )
  })

  it('non-vacuity: without the filter the note WOULD be emitted (the rule is what drops it)', () => {
    const entry = '> Box 1 stays unticked on purpose: it is a claim about main'
    const wouldBeAPath = !(
      entry.startsWith('_(') ||
      entry.startsWith('#') ||
      /^[-=]{3,}$/.test(entry) ||
      /^(\^)?split:/i.test(entry) ||
      /^(<!--|-->)/.test(entry)
    )
    assert.equal(
      wouldBeAPath,
      true,
      'the pre-existing filters do not cover a `>` prefix',
    )
    assert.equal(parseScope(['## Files', entry].join('\n')).length, 0)
  })
})
