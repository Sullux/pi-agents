const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { Cli } = require('../../src/cli')
const { CoordService } = require('../../src/coord')

// #3: pins the reported SYMPTOM at the verb, not just the helper - `page coord hub`
// used to exit 0 and print `Posted to hub` having posted a 23-byte header with no
// content. The real CoordService is injected over a mock github so the leading
// `on|blocked|next` strip is exercised too: that is the second guard, and `hub on` is
// the case only IT can catch.
describe('page coord hub (#3)', () => {
  const harness = () => {
    const posted = []
    const out = []
    const err = []
    const cli = Cli({
      coordFactory: ({ agent }) =>
        CoordService({
          github: {
            commentIssue: async (num, body) => posted.push({ num, body }),
          },
          agent,
          human: 'Sullux',
        }),
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
    })
    return { cli, posted, out, err }
  }
  const run = (argv) => harness().cli.run(['coord', 'hub', ...argv])

  it('posts a plain positional and reports the hub number', async () => {
    const { cli, posted, out } = harness()
    const code = await cli.run(['coord', 'hub', 'starting the wave'])
    assert.equal(code, 0)
    assert.equal(posted.length, 1)
    assert.ok(posted[0].body.includes('starting the wave'))
    assert.match(out.join('\n'), /Posted to hub #\d+/)
  })

  it('posts a --body-file, the idiom that used to post an empty stub', async () => {
    const path = join(tmpdir(), `hub-3-${Date.now()}.md`)
    writeFileSync(path, 'the long markdown body\n')
    try {
      const { cli, posted } = harness()
      const code = await cli.run(['coord', 'hub', '--body-file', path])
      assert.equal(code, 0)
      assert.equal(posted.length, 1)
      assert.ok(posted[0].body.includes('the long markdown body'))
    } finally {
      rmSync(path, { force: true })
    }
  })

  // The exact reported failure: no argument at all.
  it('refuses a bare verb - exit 1, no success line, NOTHING posted', async () => {
    const { cli, posted, out, err } = harness()
    const code = await cli.run(['coord', 'hub'])
    assert.equal(code, 1)
    assert.equal(posted.length, 0, 'no API call was made')
    assert.equal(out.join(''), '', 'no "Posted to hub" on stdout')
    assert.match(err.join('\n'), /Usage: page coord hub/)
  })

  // The second guard: 'on' is non-empty in the CLI, and only coord.hub's strip empties it.
  it('refuses `hub on` after the subverb strip - the guard the CLI cannot provide', async () => {
    const { cli, posted, out } = harness()
    const code = await cli.run(['coord', 'hub', 'on'])
    assert.equal(code, 1)
    assert.equal(posted.length, 0, 'a stripped-to-empty message posts nothing')
    assert.equal(out.join(''), '')
  })

  it('keeps `hub on <text>` working - the strip must not over-fire', async () => {
    const { cli, posted } = harness()
    const code = await cli.run(['coord', 'hub', 'on', 'starting journey tests'])
    assert.equal(code, 0)
    assert.equal(posted.length, 1)
    assert.ok(posted[0].body.includes('starting journey tests'))
    assert.ok(
      !posted[0].body.includes('on starting'),
      'leading subverb stripped',
    )
  })

  it('refuses an unreadable --body-file rather than posting without it', async () => {
    const { cli, posted } = harness()
    const missing = join(tmpdir(), `hub-3-absent-${Date.now()}.md`)
    await assert.rejects(() =>
      cli.run(['coord', 'hub', '--body-file', missing]),
    )
    assert.equal(posted.length, 0)
  })
})

// #29 guard 1 at the verb: the placeholder used to print `Posted to hub #4` and exit 0
// with the literal token on the fleet timeline. This is the arm that reproduces the
// reported symptom, not the helper's reaction to it - refusal means exit 1, an empty
// stdout, and no API call.
describe('page coord hub refuses an unread placeholder (#29 guard 1)', () => {
  const harness = () => {
    const posted = []
    const out = []
    const err = []
    const cli = Cli({
      coordFactory: ({ agent }) =>
        CoordService({
          github: {
            commentIssue: async (num, body) => posted.push({ num, body }),
          },
          agent,
          human: 'Sullux',
        }),
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
    })
    return { cli, posted, out, err }
  }

  it('refuses the hand-typed stamp slot without posting', async () => {
    const { cli, posted, out, err } = harness()
    const code = await cli.run(['coord', 'hub', '17:0X wave two merged'])
    assert.equal(code, 1)
    assert.equal(posted.length, 0, 'nothing reached the hub')
    assert.equal(out.join(''), '', 'no "Posted to hub" success line')
    assert.match(err.join('\n'), /unreplaced time token/)
  })

  it('posts a measured stamp, so the guard cannot be a stamp ban', async () => {
    const { cli, posted } = harness()
    const code = await cli.run(['coord', 'hub', '16:59Z wave two merged'])
    assert.equal(code, 0)
    assert.equal(posted.length, 1)
    assert.match(posted[0].body.split('\n')[2], /^16:59Z wave two merged$/)
  })
})
