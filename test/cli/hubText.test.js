const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const {
  HubText,
  HUB_USAGE,
  ensureStamp,
  stampOfUtc,
} = require('../../src/cli/hubText')

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

// #29 guard 1: an unreplaced placeholder posts a PLAUSIBLE time to the fleet's
// timeline. Both incidents here were live on pitcairn hub #4 - `17:0X` (comment
// 6475165205, patched in place) and `17:1xZ` (comment 6475722483, patched after the
// author noticed) - and the tool printed `Posted to hub #4` and exited 0 for both, so
// the refusal is asserted on the returned `error`, never on an exit status.
describe('coord hub placeholder refusal (#29 guard 1)', () => {
  const hubText = HubText(() => 'unused in these arms')
  const refuses = (text, token) => {
    const res = hubText({}, text)
    assert.equal(res.text, undefined, `must not resolve text: ${text}`)
    assert.ok(
      res.error.includes(token),
      `error must name ${token}: ${res.error}`,
    )
    assert.ok(res.error.includes(HUB_USAGE), 'the usage line still prints')
  }

  it('refuses a hand-typed stamp slot', () =>
    refuses('17:0X wave two merged', 'an unreplaced time token'))

  // The leading-position reading of #29 would have posted my own incident again: the
  // placeholder sat mid-line, inside a sentence about the placeholder.
  it('refuses the mid-line form too', () =>
    refuses(
      'patched the note stamped 17:1xZ to a measured clock',
      'an unreplaced time token',
    ))

  it('refuses every template slot shape, naming the one it hit', () => {
    refuses('wave XX ships after the freeze', 'a bare XX')
    refuses('verified at <sha> on main', 'a <sha> template slot')
    refuses('the pin lives in src/<path>', 'a <path> template slot')
    refuses('closes issue <number> cleanly', 'a <number> template slot')
    refuses('TODO rebase onto main', 'a leading TODO')
    refuses('  FIXME the hub stamp', 'a leading FIXME')
  })

  // The direction that decides whether this guard survives a week. Measured false
  // positive it must not reproduce: a `[0-9]{2}:[0-9]{2}Z` scan of a teammate's hub
  // body returned SEVEN "invalid stamps" (59:31Z, 26:03Z, 57:58Z ...), every one the
  // tail of a legitimate HH:MM:SSZ sitting in accurate prose.
  it('posts a line that carries valid timestamps', () => {
    const text = 'merged at 15:26:03Z, the pane settled by 15:57:58Z'
    assert.equal(hubText({}, text).error, undefined)
    assert.equal(hubText({}, text).text, text)
  })

  it('posts a QUOTED placeholder - documenting one is not typing one', () => {
    const text = 'the guard refuses `17:0X` and `XX` in a hub line'
    assert.equal(hubText({}, text).text, text)
  })

  it('posts TODO mid-sentence, since only a leading one is an unread note', () => {
    const text = 'closed the TODO list item that blocked the wave'
    assert.equal(hubText({}, text).error, undefined)
  })

  it('refuses a placeholder arriving through --body-file, not just a positional', () => {
    const fromFile = HubText(() => 'stamped 17:0X by mistake')
    const res = fromFile({ 'body-file': '/tmp/x.md' }, '')
    assert.ok(res.error.includes('an unreplaced time token'))
    assert.equal(res.text, undefined)
  })

  it('still refuses emptiness before hunting placeholders', () => {
    assert.ok(hubText({}, '   \n ').error.includes('nothing to post'))
  })
})

// Guard 2's own contract, tested where it is defined. hub() composes the `**SYNC**`
// marker first and then calls this, so BOTH shapes are live: with a head (the real
// post) and without one (a bare message, as a future caller would hand it).
describe('ensureStamp owns only the leading token (#29 guard 2)', () => {
  const clock = () => Date.UTC(2025, 10, 24, 16, 0, 0)
  const SYNC =
    '**SYNC** | agent: agent-delta | human: @Sullux | at: 1764000000000'

  it('derives the stamp from the injected clock', () => {
    assert.equal(stampOfUtc(clock), '16:00Z')
    assert.equal(
      ensureStamp(`${SYNC}\n\nwave two merged`, clock).text,
      `${SYNC}\n\n16:00Z wave two merged`,
      'the stamp goes on the message line, below the marker',
    )
  })

  it('prepends to a bare message when there is no marker to step over', () => {
    assert.equal(
      ensureStamp('wave two merged', clock).text,
      '16:00Z wave two merged',
    )
  })

  it('leaves an author-supplied stamp alone in either precision', () => {
    for (const body of [
      '16:59Z reviewed the pair',
      '15:26:03Z reviewed the pair',
    ]) {
      const res = ensureStamp(`${SYNC}\n\n${body}`, clock)
      assert.equal(
        res.text,
        `${SYNC}\n\n${body}`,
        `${body} must not double-stamp`,
      )
    }
  })

  it('refuses an out-of-range leading stamp and says nothing was posted', () => {
    const res = ensureStamp(`${SYNC}\n\n25:99Z bogus`, clock)
    assert.equal(res.text, undefined)
    assert.ok(res.error.includes('"25:99Z"'), res.error)
    assert.ok(res.error.includes('nothing was posted'), res.error)
  })

  it('never mistakes a timestamp inside the body for the leading stamp', () => {
    const res = ensureStamp(`${SYNC}\n\nmerged at 15:26:03Z`, clock)
    assert.equal(res.text, `${SYNC}\n\n16:00Z merged at 15:26:03Z`)
  })
})
