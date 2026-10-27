const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { CoordService } = require('../../src/coord')

describe('Coordination Protocol: Service Methods', () => {
  it('hub command strips leading subverbs and formats SYNC comment', async () => {
    let posted = []
    const mockGithub = {
      commentIssue: async (num, body) => {
        posted.push({ num, body })
      },
    }

    const coord = CoordService({
      github: mockGithub,
      agent: 'delta',
      human: 'Sullux',
    })

    await coord.hub('on starting journey tests; nothing blocking')
    assert.equal(posted.length, 1)
    assert.equal(posted[0].num, 4)
    assert.ok(posted[0].body.includes('delta | human: @Sullux'))
    assert.ok(
      posted[0].body.includes('starting journey tests; nothing blocking'),
    )
    assert.ok(!posted[0].body.includes('on starting'))
  })

  // #3: the service guard. An empty body still produced a well-formed 23-byte header
  // that the API accepted, so nothing downstream objected either - the refusal has to
  // live here, after the subverb strip and before the call.
  const emptyHarness = () => {
    const posted = []
    const coord = CoordService({
      github: {
        commentIssue: async (num, body) => {
          posted.push({ num, body })
        },
      },
      agent: 'delta',
      human: 'Sullux',
    })
    return { coord, posted }
  }

  it('hub refuses empty text WITHOUT calling the API', async () => {
    const { coord, posted } = emptyHarness()
    const res = await coord.hub('')
    assert.equal(res.ok, false)
    assert.equal(posted.length, 0, 'the refusal must precede the post')
  })

  it('hub refuses whitespace-only text', async () => {
    const { coord, posted } = emptyHarness()
    assert.equal((await coord.hub('   \n ')).ok, false)
    assert.equal(posted.length, 0)
  })

  it('hub refuses text that the subverb strip empties', async () => {
    const { coord, posted } = emptyHarness()
    for (const word of ['on', 'blocked', 'next']) {
      assert.equal((await coord.hub(word)).ok, false, `${word} strips to empty`)
    }
    assert.equal(posted.length, 0)
  })

  it('hub omits the default entirely - calling it with no argument cannot post', async () => {
    const { coord, posted } = emptyHarness()
    assert.equal((await coord.hub()).ok, false)
    assert.equal(posted.length, 0)
  })

  // Widening the strip to match a bare subverb must not eat ordinary words that merely
  // begin with one - the over-fire twin of the refusal pins above. Each case here has the
  // subverb as a PREFIX of a longer token, so neither `\s+` nor `$` can match it. A whole
  // leading word followed by a space IS stripped by design (see the 'hub on <text>' pin in
  // test/cli/hub-verb.test.js), so a case like 'blocked on #872' belongs to that behaviour,
  // not to this one.
  it('hub does not strip words that only START with a subverb', async () => {
    const { coord, posted } = emptyHarness()
    for (const text of [
      'once upon a time',
      'onward to the next wave',
      'blocked-out rail work continues',
      'next-generation seed data is pending',
    ]) {
      const res = await coord.hub(text)
      assert.equal(res.ok, true, `should post: ${text}`)
    }
    assert.equal(posted.length, 4)
    assert.ok(posted[0].body.includes('once upon a time'))
    assert.ok(posted[1].body.includes('onward to the next wave'))
    assert.ok(
      posted[2].body.includes('blocked-out rail work continues'),
      'a hyphenated prefix keeps its first word',
    )
    assert.ok(posted[3].body.includes('next-generation seed data is pending'))
  })

  it('review command moves issue to status:in-review and posts comment', async () => {
    let edited = []
    let commented = []

    const mockGithub = {
      viewIssue: async (num) => ({
        number: num,
        labels: [{ name: 'status:claimed' }, { name: 'p1' }],
      }),
      commentIssue: async (num, body) => {
        commented.push({ num, body })
      },
      editIssue: async (num, edits) => {
        edited.push({ num, edits })
      },
    }

    const coord = CoordService({
      github: mockGithub,
      agent: 'alpha',
      human: 'Sullux',
      now: () => 1700000000000,
    })

    const res = await coord.review(50, { pr: 123, text: 'ready for review' })
    assert.equal(res.ok, true)
    assert.deepEqual(edited[0].edits.addLabels, ['status:in-review'])
    assert.deepEqual(edited[0].edits.removeLabels, ['status:claimed'])
    assert.ok(commented[0].body.includes('**REVIEW** | agent: agent-alpha'))
    assert.ok(commented[0].body.includes('pr: #123'))
  })

  it('done command strips status labels, closes issue, and avoids status:done', async () => {
    let closed = []
    let edited = []
    let commented = []

    const mockGithub = {
      viewIssue: async (num) => ({
        number: num,
        labels: [{ name: 'status:in-review' }, { name: 'p1' }],
      }),
      commentIssue: async (num, body) => {
        commented.push({ num, body })
      },
      editIssue: async (num, edits) => {
        edited.push({ num, edits })
      },
      closeIssue: async (num) => {
        closed.push(num)
      },
    }

    const coord = CoordService({
      github: mockGithub,
      agent: 'alpha',
      human: 'Sullux',
      now: () => 1700000000000,
    })

    const res = await coord.done(50, { pr: 123, text: 'resolved cleanly' })
    assert.equal(res.ok, true)
    assert.equal(closed[0], 50)
    assert.deepEqual(edited[0].edits.removeLabels, ['status:in-review'])
    assert.equal(edited[0].edits.addLabels, undefined)
    assert.ok(commented[0].body.includes('**DONE** | agent: agent-alpha'))
    assert.ok(commented[0].body.includes('pr: #123'))
  })

  it('formatBoard does not truncate long agent owner IDs', () => {
    const { formatBoard } = require('../../src/coord/formatters')
    const longAgent = 'qwen3.8-flash-foxtrot'
    const issues = [
      {
        number: 758,
        title: 'Long owner ID test',
        body: '## Files\nsrc/test.js',
        labels: [{ name: 'status:claimed' }, { name: 'ws:admin' }],
        comments: [{ body: `**CLAIM** | agent: ${longAgent} | at: 100` }],
      },
    ]

    const board = formatBoard(issues, 'other')
    assert.ok(board.includes(longAgent))
  })
})
