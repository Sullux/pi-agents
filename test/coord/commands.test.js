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
    // #29 changed this expectation on purpose: the message line now leads with the
    // tool's own stamp, so `at: <ms>` in the marker is not the only readable time.
    // The marker stays the FIRST line - the stamp belongs below it, not above it.
    assert.equal(message, '16:00Z body text here')
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
        // #28: `done` now refuses unless the caller holds the claim, so this fixture has to
        // carry alpha's CLAIM - completing the double, not loosening the guard
        comments: [
          { body: '**CLAIM** | agent: agent-alpha | at: 1700000000000' },
        ],
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

// #29 guard 2 at the verb that owns the post. These arms exist because the stamp is
// applied HERE rather than in the CLI: hub() strips a leading `on|blocked|next` first
// (#3), and a stamp prepended before that strip would bury the subverb behind it and
// resurrect the literal-`on` post - so the pair below is a coexistence pin, not a
// duplicate of the unit arms in test/cli/hubText.test.js.
describe('coord hub stamps its own line (#29 guard 2)', () => {
  const stampHarness = (nowValue) => {
    const posted = []
    const coord = CoordService({
      github: {
        commentIssue: async (num, body) => posted.push({ num, body }),
      },
      agent: 'delta',
      human: 'Sullux',
      now: () => nowValue,
    })
    const messageLine = () => posted[0].body.split('\n')[2]
    return { coord, posted, messageLine }
  }
  const CLOCK = Date.UTC(2025, 10, 24, 16, 0, 0)

  it('prepends the injected clock to the message line, below the marker', async () => {
    const { coord, posted, messageLine } = stampHarness(CLOCK)
    const res = await coord.hub('wave two merged at the tip')
    assert.equal(res.ok, true)
    assert.equal(posted.length, 1)
    assert.ok(
      posted[0].body.split('\n')[0].startsWith('**SYNC**'),
      'the protocol marker stays the first line',
    )
    assert.equal(messageLine(), '16:00Z wave two merged at the tip')
  })

  it('stamps AFTER the subverb strip, so both guards stay live', async () => {
    const { coord, messageLine } = stampHarness(CLOCK)
    await coord.hub('on starting journey tests')
    assert.equal(
      messageLine(),
      '16:00Z starting journey tests',
      'the literal `on` must not survive behind a stamp',
    )
  })

  it('does not double-stamp an author who already read the clock', async () => {
    const { coord, messageLine } = stampHarness(CLOCK)
    await coord.hub('16:59Z reviewed the pair')
    assert.equal(messageLine(), '16:59Z reviewed the pair')
    const precise = stampHarness(CLOCK)
    await precise.coord.hub('15:26:03Z merged the union')
    assert.equal(precise.messageLine(), '15:26:03Z merged the union')
  })

  it('refuses an out-of-range leading stamp WITHOUT posting', async () => {
    const { coord, posted } = stampHarness(CLOCK)
    const res = await coord.hub('25:99Z bogus time')
    assert.equal(res.ok, false)
    assert.ok(res.error.includes('25:99Z'), res.error)
    assert.equal(posted.length, 0, 'no API call was made')
  })

  it('leaves accurate timestamp prose alone apart from its own stamp', async () => {
    const { coord, messageLine } = stampHarness(CLOCK)
    await coord.hub('merged at 15:26:03Z, settled by 15:57:58Z')
    assert.equal(
      messageLine(),
      '16:00Z merged at 15:26:03Z, settled by 15:57:58Z',
      'a stamp inside the body is not the leading stamp',
    )
  })
})

// #34: pi-agents carries NO status:* labels (measured: `gh label list --json name` answers
// bug/enhancement/coordinate only), so `page coord claim 34` wrote its **CLAIM** comment and
// THEN died with `'status:unclaimed' not found`, exiting 1 on work it had already done. The
// retry path is what makes that expensive: a caller that reads a nonzero exit as "not mine"
// claims again, and three agents pile up duplicates of the same task (#238). Two half-bugs are
// fixed here - gh refuses to REMOVE a label the issue does not carry (so removals are filtered
// against the issue's own labels), and gh refuses to ADD a label the repo never created (which
// cannot be pre-filtered without a repo-wide taxonomy read, deliberately avoided: a skipped add
// would look like a board move that never happened). A residual failure is now returned as
// `labelWarning`, never thrown, and the CLI prints it.
describe('coord label mutation is best-effort (#34)', () => {
  const GH_ERROR =
    "failed to update https://github.com/Sullux/pi-agents/issues/34: 'status:unclaimed' not found\nfailed to update 1 issue"

  const harness = ({
    labels = [{ name: 'status:claimed' }, { name: 'bug' }],
    fail = true,
  } = {}) => {
    const commented = []
    const edited = []
    const closed = []
    const issue = {
      number: 34,
      body: '## Files\nsrc/foo.js\n\n## Goal\nTest',
      labels,
      // #28: the caller must hold the issue for `done` to proceed, so the shared fixture carries
      // delta's own CLAIM. `claim` is unaffected (a self-claim is still claimable), and the race
      // check resolves to a win for the same reason.
      comments: [
        { body: '**CLAIM** | agent: agent-delta | at: 1700000000000' },
      ],
    }
    const coord = CoordService({
      github: {
        viewIssue: async () => issue,
        listIssues: async () => [issue],
        commentIssue: async (num, body) => {
          commented.push({ num, body })
        },
        editIssue: async (num, edits) => {
          edited.push({ num, edits })
          if (fail) {
            const error = new Error(GH_ERROR)
            error.stderr = GH_ERROR
            throw error
          }
        },
        closeIssue: async (num) => {
          closed.push(num)
        },
      },
      agent: 'delta',
      human: 'Sullux',
      now: () => 1700000000000,
    })
    return { coord, commented, edited, closed }
  }

  const verbs = [
    [
      'claim',
      (coord) => coord.claim(34, { plan: 'p', eta: '10m' }),
      '**CLAIM**',
    ],
    [
      'release',
      (coord) => coord.release(34, { reason: 'done for today' }),
      '**RELEASE**',
    ],
    [
      'review',
      (coord) => coord.review(34, { pr: 33, text: 'verdict' }),
      '**REVIEW**',
    ],
    [
      'done',
      (coord) => coord.done(34, { pr: 33, text: 'attested' }),
      '**DONE**',
    ],
  ]

  for (const [name, call, marker] of verbs) {
    it(`${name} returns ok + a labelWarning instead of throwing after its comment lands`, async () => {
      const { coord, commented, edited } = harness()
      const res = await call(coord)
      assert.equal(res.ok, true, `${name} recorded its protocol event`)
      assert.equal(
        commented.length,
        1,
        `exactly one ${marker} comment - box 4's ordering hazard, and a retry would post the second`,
      )
      assert.ok(
        commented[0].body.startsWith(marker),
        `the ${marker} comment was written before gh refused`,
      )
      assert.equal(
        edited.length,
        1,
        'the edit was ATTEMPTED - the warning is not a skip',
      )
      assert.ok(
        res.labelWarning.includes("'status:unclaimed' not found"),
        `gh's own sentence must survive, not a paraphrase: ${res.labelWarning}`,
      )
    })
  }

  it('collapses the warning to one line and prefers gh stderr over the exec prefix', async () => {
    const { coord } = harness()
    const res = await coord.claim(34, { plan: 'p' })
    assert.ok(res.labelWarning, 'this arm needs a warning to describe')
    assert.ok(
      !res.labelWarning.includes('\n'),
      `a multi-line warning escapes the CLI's leading decoration: ${res.labelWarning}`,
    )
    assert.ok(
      !res.labelWarning.includes('Command failed'),
      `the redundant execFileSync preamble should lose to gh's own stderr: ${res.labelWarning}`,
    )
  })

  it('done still closes the issue when the label edit fails', async () => {
    const { coord, closed } = harness()
    const res = await coord.done(34, { text: 'attested' })
    assert.equal(res.ok, true)
    assert.deepEqual(
      closed,
      [34],
      'a failed decoration cannot skip the outcome',
    )
  })

  it('does not ask gh to remove a label the issue does not carry', async () => {
    const { coord, edited } = harness({ labels: [{ name: 'bug' }] })
    await coord.claim(34, { plan: 'p' })
    assert.equal(
      edited[0].edits.removeLabels,
      undefined,
      'the fixed list was half of #34: gh refuses absent removals, so it must not be asked',
    )
    assert.deepEqual(edited[0].edits.addLabels, ['status:claimed'])
  })

  it('removes a status label the issue DOES carry - the filter is not a no-op', async () => {
    const { coord, edited } = harness({
      labels: [{ name: 'status:unclaimed' }, { name: 'p2' }],
    })
    await coord.claim(34, { plan: 'p' })
    assert.deepEqual(
      edited[0].edits.removeLabels,
      ['status:unclaimed'],
      'a present label must still be removed, or the board freezes claimed',
    )
  })

  it('done with no status labels attempts no edit at all', async () => {
    const { coord, edited, closed } = harness({
      labels: [{ name: 'bug' }],
      fail: false,
    })
    await coord.done(34, { text: 'attested' })
    assert.deepEqual(edited, [], 'nothing to remove means no doomed gh call')
    assert.deepEqual(closed, [34])
  })

  it('reports no warning when the edit succeeds - the warning is conditional', async () => {
    const { coord } = harness({ fail: false })
    for (const res of [
      await coord.claim(34, { plan: 'p' }),
      await coord.release(34),
      await coord.review(34, { text: 'v' }),
      await coord.done(34, { text: 'a' }),
    ]) {
      assert.equal(res.ok, true)
      assert.equal(res.labelWarning, undefined)
    }
  })
})

describe('#28 done refuses to close an issue the caller does not hold', () => {
  // A recorder harness, because box 5 is about what did NOT happen: pitcairn #1104's damage was
  // the three writes that landed before anyone asked who owned the issue, so a returned error
  // string alone is only half the fix. `writes` sees comment / edit / close and nothing else.
  const world = ({
    agent,
    comments = [],
    labels = [{ name: 'status:claimed' }],
  }) => {
    const writes = []
    const github = {
      viewIssue: async () => ({
        number: 700,
        title: '#28 fixture',
        body: '## Files\nsrc/x.js',
        labels,
        comments,
      }),
      listIssues: async () => [],
      commentIssue: async () => {
        writes.push('comment')
        return { html_url: 'https://example.test/c' }
      },
      editIssue: async () => {
        writes.push('edit')
        return {}
      },
      closeIssue: async () => {
        writes.push('close')
        return {}
      },
    }
    return { coord: CoordService({ github, agent }), writes }
  }

  const claim = (agent, at = 1700000000000) => ({
    body: `**CLAIM** | agent: ${agent} | at: ${at}`,
    createdAt: new Date(at).toISOString(),
  })
  const marker = (body, at = '2023-11-15T00:05:00.000Z') => ({
    body,
    createdAt: at,
  })

  // every timeline below carries both its expected verdict and the side-effect floor, so a guard
  // that returns the right string but keeps writing cannot pass
  const cases = [
    {
      name: 'my CLAIM, I am the owner: allowed, and all three writes land',
      comments: [claim('agent-delta')],
      expect: { ok: true, writes: ['comment', 'edit', 'close'] },
    },
    {
      name: 'a peer CLAIM on an open issue: refused, ZERO writes (pitcairn #1104, 11 minutes in)',
      comments: [claim('agent-echo')],
      expect: {
        ok: false,
        writes: [],
        namesOwner: /held by agent-echo/,
        namesTime: /CLAIM\*\* at 2023-11-14T22:13:20\.000Z/,
      },
    },
    {
      name: 'I released, then another agent claimed: refused, ZERO writes',
      comments: [
        claim('agent-delta', 1600000000000),
        marker('**RELEASE** | agent: agent-delta | at: 1600000001000'),
        claim('agent-foxtrot', 1700000000000),
      ],
      expect: { ok: false, writes: [], namesOwner: /held by agent-foxtrot/ },
    },
    {
      name: "another agent's DONE closed out MY claim: still mine to close (unheld + my CLAIM)",
      comments: [
        claim('agent-delta'),
        marker('**DONE** | agent: agent-echo | pr: #701 | at: 1700000009999'),
      ],
      expect: { ok: true, writes: ['comment', 'edit', 'close'] },
    },
    {
      name: 'no CLAIM at all: refused - "no owner" is not evidence that it is mine',
      comments: [marker('just a status update, no protocol marker')],
      expect: {
        ok: false,
        writes: [],
        namesGuard: /unheld and carries no \*\*CLAIM\*\* by agent-delta/,
      },
    },
    {
      // deliberate, and pinned so it cannot be mistaken for a hole: box 2 refuses when the issue
      // "carries no claim by the caller". This one DOES - it was handed back and nobody took it,
      // so the board is genuinely free and there is no in-flight peer to step on. Refusing here
      // would need a second fold of my own markers, i.e. a second definition of the protocol
      // beside ownerOf's, and that drift risk is worse than the gap it closes.
      name: 'I released and nobody re-claimed: allowed - unheld, but my CLAIM is on the record',
      comments: [
        claim('agent-delta', 1600000000000),
        marker('**RELEASE** | agent: agent-delta | at: 1600000001000'),
      ],
      expect: { ok: true, writes: ['comment', 'edit', 'close'] },
    },
    {
      name: 'I re-claimed after releasing: allowed again, the fold is order-sensitive',
      comments: [
        claim('agent-delta', 1600000000000),
        marker('**RELEASE** | agent: agent-delta | at: 1600000001000'),
        claim('agent-delta', 1700000000000),
      ],
      expect: { ok: true, writes: ['comment', 'edit', 'close'] },
    },
  ]

  for (const { name, comments, expect } of cases) {
    it(name, async () => {
      const { coord, writes } = world({ agent: 'agent-delta', comments })
      const res = await coord.done(700, { text: 'attested' })
      assert.equal(res.ok, expect.ok, `${name} - verdict (got: ${res.error})`)
      assert.deepEqual(writes, expect.writes, `${name} - side effects`)
      if (!expect.ok) {
        assert.match(res.error, expect.namesOwner || /./, 'owner naming')
        assert.match(res.error, expect.namesTime || /at /, 'names a time')
        assert.match(
          res.error,
          expect.namesGuard || /Claim it/,
          'names the way through',
        )
        assert.match(
          res.error,
          /--force/,
          'a refusal must point at the override, or the next agent invents one',
        )
      }
    })
  }

  it('--force closes a peer-held issue and reports that it was forced', async () => {
    const { coord, writes } = world({
      agent: 'agent-delta',
      comments: [claim('agent-echo')],
    })
    const res = await coord.done(700, { text: 'supervisor sweep', force: true })
    assert.equal(res.ok, true, 'the override is honored')
    assert.deepEqual(
      writes,
      ['comment', 'edit', 'close'],
      'and it really did the work',
    )
    assert.equal(res.forced, true, 'forced must be reported, not kept private')
    assert.equal(
      res.owner,
      'echo',
      'the record names whose claim was stepped on',
    )
  })

  it('a self-owned close reports forced: false, so the note cannot become noise', async () => {
    const { coord } = world({
      agent: 'agent-delta',
      comments: [claim('agent-delta')],
    })
    const res = await coord.done(700, { text: 'routine' })
    assert.equal(res.forced, false)
    assert.equal(res.owner, 'delta')
  })

  it('a CLAIM with no parseable timestamp refuses without throwing', async () => {
    // new Date(NaN).toISOString() RangeErrors, and a guard that crashes on a thin mock is a
    // failure path wearing a success path - the fleet would read it as a gh outage
    const { coord, writes } = world({
      agent: 'agent-delta',
      comments: [{ body: '**CLAIM** | agent: agent-echo | at: not-a-time' }],
    })
    const res = await coord.done(700, { text: 'x' })
    assert.equal(res.ok, false)
    assert.match(res.error, /held by agent-echo/)
    assert.match(res.error, /time unknown/)
    assert.deepEqual(writes, [])
  })

  it('the identity comparison is cleanAgent-normalized, not string-equal', async () => {
    // measured: the CLI passes "agent-Delta" while the protocol line reads "agent-delta" and a
    // profile can read "pi/delta" - a raw === would refuse your OWN issue on one of the three
    const variants = ['agent-delta', 'delta', 'pi/delta', 'Agent-Delta']
    for (const agent of variants) {
      const { coord, writes } = world({
        agent,
        comments: [claim('agent-delta')],
      })
      const res = await coord.done(700, { text: 'x' })
      assert.equal(res.ok, true, `${agent} must resolve to the same holder`)
      assert.deepEqual(writes, ['comment', 'edit', 'close'])
    }
  })

  it('review keeps NO ownership check, and that asymmetry is pinned on purpose (#28)', async () => {
    // A verdict is supposed to come from someone other than the holder, so `done` destroying a
    // peer's board state and `review` publishing a verdict are different in kind. This arm exists
    // so a future "consistency" pass cannot quietly add a guard that breaks the review gate.
    const { coord, writes } = world({
      agent: 'agent-delta',
      comments: [claim('agent-echo')],
    })
    const res = await coord.review(700, { pr: '9', text: 'APPROVE' })
    assert.equal(res.ok, true, 'a non-owner may still review')
    assert.deepEqual(writes, ['comment', 'edit'])
  })
})

describe("#28 hasClaimBy shares ownerOf's parser, so the token shape cannot drift", () => {
  const { hasClaimBy } = require('../../src/coord/owner')

  it('a line-initial CLAIM by the caller counts, and a prose mention does not', async () => {
    assert.equal(
      hasClaimBy(
        [{ body: '**CLAIM** | agent: agent-delta | at: 1' }],
        'pi/delta',
      ),
      true,
      'the real shape must be recognized',
    )
    assert.equal(
      hasClaimBy([{ body: 'I said **CLAIM** in a sentence' }], 'delta'),
      false,
      'PROTOCOL_REGEX is line-anchored, and so must this be',
    )
    assert.equal(
      hasClaimBy([{ body: '**CLAIM** | agent: agent-echo | at: 1' }], 'delta'),
      false,
      'someone else claim is not my claim',
    )
    assert.equal(
      hasClaimBy([], 'delta'),
      false,
      'an empty timeline claims nothing',
    )
    assert.equal(
      hasClaimBy([{ body: '**CLAIM**' }], ''),
      false,
      'an empty agent claims nothing',
    )
  })
})
