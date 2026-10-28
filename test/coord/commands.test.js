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

  // #2: hub() emitted no verb marker and no timestamp, so a SYNC line was not
  // classifiable by shape and two updates from one agent carried no ordering. These pins
  // inject `now` so the seam is PROVEN traveled rather than assumed - a hardcoded
  // Date.now() would make `at:` a plausible-looking value that no assertion can pin.
  const markerHarness = (nowValue) => {
    const posted = []
    const coord = CoordService({
      github: {
        commentIssue: async (num, body) => {
          posted.push({ num, body })
        },
      },
      agent: 'bravo',
      human: 'Sullux',
      now: () => nowValue,
    })
    return { coord, posted }
  }

  it('hub emits the **SYNC** marker as the FIRST line, shape-classifiable', async () => {
    const { coord, posted } = markerHarness(1764000000000)
    await coord.hub('reviewing #943 at the merged tip')
    assert.equal(
      posted[0].body.split('\n')[0],
      '**SYNC** | agent: agent-bravo | human: @Sullux | at: 1764000000000',
    )
  })

  it('hub separates the marker from the message with a blank line', async () => {
    const { coord, posted } = markerHarness(1764000000001)
    await coord.hub('body text here')
    const [, blank, message] = posted[0].body.split('\n')
    assert.equal(
      blank,
      '',
      'blank line after the marker, like CLAIM/STATUS/DONE',
    )
    assert.equal(message, 'body text here')
  })

  it('hub stamps the INJECTED clock, so two posts are orderable', async () => {
    const early = markerHarness(1764000000100)
    await early.coord.hub('first update')
    const late = markerHarness(1764000000900)
    await late.coord.hub('second update')
    const at = (b) => Number(b.match(/\| at: (\d+)/)[1])
    assert.ok(
      at(early.posted[0].body) < at(late.posted[0].body),
      'strictly ordered',
    )
    assert.equal(
      at(early.posted[0].body),
      1764000000100,
      'the value is the injected now(), not a wall clock',
    )
  })

  it('hub still refuses an empty post BEFORE writing any marker', async () => {
    const { coord, posted } = markerHarness(1764000000200)
    const res = await coord.hub('   ')
    assert.equal(res.ok, false)
    assert.equal(
      posted.length,
      0,
      'a refusal must not emit a marker-only comment',
    )
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

// #15: `scope.js`'s `labelNames` tolerates gh's object labels AND a normalized string list, and the
// gate (`statusOf`) already read through it - but `formatters.js` read `l.name` directly at six
// sites, so a caller that normalized labels first got a coordination gate that worked and a board
// that threw `TypeError: Cannot read properties of undefined (reading 'startsWith')`. The contract
// is that BOTH shapes render the SAME row. The `hub` filter is asserted under both shapes because it
// could not throw (`l.name === 'hub'` is simply false for a string), so it silently kept the hub
// issue as a board row - a wrong render, not a crash, and visible only once the crash was fixed.
describe('Coordination Protocol: label-shape contract (#15)', () => {
  const status = (labels) => ({
    number: 42,
    title: 'Label shape probe',
    body: '## Files\nsrc/x.js',
    labels,
    comments: [{ body: '**CLAIM** | agent: alpha | at: 2026-10-28T04:00:00Z' }],
  })
  const hubRow = (labels) => ({
    number: 4,
    title: 'Coordination hub',
    body: '## Files\nsrc/hub.js',
    labels,
    comments: [],
  })

  const asObjects = (...names) => names.map((name) => ({ name }))
  const asStrings = (...names) => names

  it('renders the identical board row from object labels and string labels', () => {
    const { formatBoard } = require('../../src/coord/formatters')
    const obj = formatBoard(
      [status(asObjects('status:claimed', 'ws:qa-audit', 'p2'))],
      'other',
    )
    const str = formatBoard(
      [status(asStrings('status:claimed', 'ws:qa-audit', 'p2'))],
      'other',
    )

    assert.ok(
      /^#42/m.test(obj),
      'non-vacuity: the object row must actually render',
    )
    assert.equal(obj, str)
    assert.ok(obj.includes('claimed'), 'status cell survives the shape change')
    assert.ok(obj.includes('qa-audit'), 'ws cell survives the shape change')
    assert.ok(obj.includes('p2'), 'priority cell survives the shape change')
    assert.ok(obj.includes('alpha'), 'owner cell survives the shape change')
  })

  it('filters the hub out of the board under BOTH shapes - the silent half of #15', () => {
    const { formatBoard } = require('../../src/coord/formatters')
    const obj = formatBoard(
      [hubRow(asObjects('hub')), status(asObjects('status:claimed'))],
      'other',
    )
    const str = formatBoard(
      [hubRow(asStrings('hub')), status(asStrings('status:claimed'))],
      'other',
    )

    assert.ok(
      !/^#4 /m.test(obj),
      'hub must not render as a board row (object shape)',
    )
    assert.ok(
      !/^#4 /m.test(str),
      'hub must not render as a board row (string shape)',
    )
    assert.equal(obj, str)
    assert.ok(/^#42/m.test(str), 'non-vacuity: the work row is still there')
  })

  it('falls back to unclaimed / - / - for empty labels under both shapes', () => {
    const { formatBoard } = require('../../src/coord/formatters')
    const obj = formatBoard([status([])], 'other')
    const str = formatBoard([status([])], 'other')

    assert.equal(obj, str)
    assert.ok(
      obj.includes('unclaimed'),
      'an absent status label still defaults, not throws',
    )
  })

  it('formatSync reads its two label sites through the same accessor', () => {
    const { formatSync } = require('../../src/coord/formatters')
    const build = (labels, humanLabels) =>
      formatSync({
        issues: [hubRow(labels), status(humanLabels)],
        currentAgent: 'other',
        hubNumber: 99,
        staleMinutes: 45,
        now: Date.parse('2026-10-28T05:00:00Z'),
      })

    const obj = build(
      asObjects('hub'),
      asObjects('needs-human', 'status:claimed'),
    )
    const str = build(
      asStrings('hub'),
      asStrings('needs-human', 'status:claimed'),
    )

    assert.ok(obj.includes('== needs-human =='), 'section renders')
    assert.ok(
      /== needs-human ==\n  #42/.test(obj),
      'non-vacuity: the flagged issue is LISTED, not just the header',
    )
    assert.ok(
      /hub #4,/.test(str),
      'hub located by label under the string shape too',
    )
    assert.equal(obj, str)
  })

  it('exports the tolerant accessor so there is one definition, not two', () => {
    const { labelNames, statusOf } = require('../../src/coord/scope')

    assert.deepEqual(labelNames({ labels: [{ name: 'p1' }, 'p2'] }), [
      'p1',
      'p2',
    ])
    assert.deepEqual(
      labelNames({ labels: undefined }),
      [],
      'no labels is empty, not a throw',
    )
    assert.equal(statusOf({ labels: ['status:in-review'] }), 'in-review')
    assert.equal(statusOf({ labels: [{ name: 'status:claimed' }] }), 'claimed')
  })
})
