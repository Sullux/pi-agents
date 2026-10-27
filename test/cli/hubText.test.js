const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { HubText, HUB_USAGE } = require('../../src/cli/hubText')

// #3: the argv shapes that used to post nothing (or a fraction) while reporting success.
// The file reader is injected so these pins need no filesystem and no network.
describe('coord hub text resolution (#3)', () => {
  const readFrom = (map) => (path) => {
    if (!(path in map)) throw new Error(`ENOENT: ${path}`)
    return map[path]
  }
  const hubText = HubText(readFrom({ '/tmp/x.md': 'the file body' }))

  it('resolves a plain positional', () => {
    assert.deepEqual(hubText({}, 'starting journey tests'), {
      text: 'starting journey tests',
    })
  })

  it('resolves --body-file, the idiom that used to post 23 bytes of header', () => {
    assert.deepEqual(hubText({ 'body-file': '/tmp/x.md' }, ''), {
      text: 'the file body',
    })
  })

  it('resolves --body', () => {
    assert.deepEqual(hubText({ body: 'inline text' }, ''), {
      text: 'inline text',
    })
  })

  // The worse half of #3: a flag plus trailing prose used to post ONLY the prose and
  // silently discard the file - a plausible-looking partial update, not an obvious empty
  // one. Concatenation is what makes dropping a part impossible.
  it('keeps BOTH the file and trailing prose rather than discarding one', () => {
    const res = hubText({ 'body-file': '/tmp/x.md' }, 'extra words here')
    assert.equal(res.error, undefined)
    assert.ok(res.text.includes('the file body'), 'file part survived')
    assert.ok(res.text.includes('extra words here'), 'positional part survived')
  })

  it('refuses a bare verb with no argument at all', () => {
    const res = hubText({}, '')
    assert.ok(res.error.includes(HUB_USAGE))
    assert.equal(res.text, undefined)
  })

  it('refuses whitespace-only text', () => {
    assert.ok(hubText({}, '   \n  ').error.includes('nothing to post'))
  })

  it('refuses --body-file given without a path instead of ignoring the flag', () => {
    const res = hubText({ 'body-file': true }, '')
    assert.ok(res.error.includes('--body-file needs a path'))
    assert.equal(res.text, undefined)
  })

  it('refuses --body given without text instead of ignoring the flag', () => {
    assert.ok(hubText({ body: true }, '').error.includes('--body needs text'))
  })

  // A flag-shaped argument with prose must not become a silent partial: the flag error
  // has to win over the prose that is present.
  it('does not let trailing prose mask a valueless flag', () => {
    const res = hubText(
      { 'body-file': true },
      'words that would otherwise post',
    )
    assert.ok(res.error.includes('--body-file needs a path'))
    assert.equal(res.text, undefined)
  })
})
