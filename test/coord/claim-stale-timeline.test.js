const { describe, it } = require('node:test')
const { strict: assert } = require('node:assert')
const { completedByOther } = require('../../src/coord/owner')
const { CoordService } = require('../../src/coord')

// #96: `claim` and `done` decided from a timeline that had already moved. Measured live on
// pitcairn #1212: delta's `**DONE**` at 23:41:05Z, bravo CLAIMED at 23:41:28Z and CLOSED at
// 23:41:32Z - a completed issue claimed and re-closed under a false lineage for ~15 minutes.
// These arms pin the fence, its release semantics, the ordering rule #28 forced (a PRIOR live
// claim protects the holder - bystander close-outs are still not theft, and stamps decide the
// order because a race can make array position and arrival disagree), and box 4's selectivity
// pairs: refusal arms and still-allows arms run the SAME timeline plus or minus one line, so a
// cosmetic guard cannot pass.
const doneLine = (agent, at = 1700000000000) =>
  `**DONE** | agent: agent-${agent} | at: ${at}`
const claimLine = (agent, at = 1699999000000) =>
  `**CLAIM** | agent: agent-${agent} | at: ${at}`
const releaseLine = (agent = '', reason = 'rework') =>
  `**RELEASE**${agent ? ` | agent: agent-${agent}` : ''} | reason: ${reason}`
const asComments = (bodies) => bodies.map((body) => ({ body }))

describe('completedByOther (the #96 fence predicate)', () => {
  it('fences B when A posted an unretracted DONE', () => {
    const fence = completedByOther(asComments([doneLine('a')]), 'b')
    assert.deepEqual(fence, {
      agent: 'a',
      at: 1700000000000,
      protectedByPriorClaim: false,
    })
  })

  it("the completer's own RELEASE lifts the fence - the pair that proves RELEASE is load-bearing", () => {
    assert.equal(
      completedByOther(asComments([doneLine('a'), releaseLine('a')]), 'b'),
      null,
    )
  })

  it("a THIRD PARTY's RELEASE does not lift it - you cannot retract someone else's completion", () => {
    const fence = completedByOther(
      asComments([doneLine('a'), releaseLine('c')]),
      'b',
    )
    assert.equal(fence.agent, 'a', 'the fence survives a bystander release')
  })

  it('an unattributed DONE fences no one (prose quotes must not lock the fleet out)', () => {
    assert.equal(
      completedByOther(
        asComments(['**DONE** | pr: #1 | (hand-written, no agent field)']),
        'b',
      ),
      null,
    )
  })

  it('never blocks its own poster: re-closing your own completed issue is routine', () => {
    assert.equal(completedByOther(asComments([doneLine('a')]), 'a'), null)
  })

  it('a CLAIM that lands AFTER the DONE does not launder it (#1212 is exactly this shape)', () => {
    const fence = completedByOther(
      asComments([doneLine('a'), claimLine('b', 1700000002000)]),
      'b',
    )
    assert.equal(
      fence.agent,
      'a',
      "bravo's post-DONE claim must not free bravo",
    )
  })

  // #28's union, pinned in both directions: pitcairn #1030 - a bystander closed out a LIVE
  // claim, and test/coord's pre-existing arm ("still mine to close") must keep passing - while
  // my own RELEASE re-arms the fence, because after I stand down the completion is the only
  // surviving word on the work.
  it('a prior LIVE CLAIM by me under the DONE protects me (#28 bystander case)', () => {
    assert.equal(
      completedByOther(asComments([claimLine('b'), doneLine('a')]), 'b'),
      null,
      'someone overwrote MY close-out; my right to close stands',
    )
    assert.equal(
      completedByOther(
        asComments([claimLine('b'), doneLine('a'), releaseLine('b')]),
        'b',
      )?.agent,
      'a',
      'but once I release my own claim the fence re-applies - selectivity, not sentiment',
    )
  })

  it('stamps decide order when both lines carry one, even against array position (the race shape)', () => {
    // my claim stamped LATER than the DONE but listed BEFORE it - what a mid-write arrival
    // actually looks like when the pre-write read missed the DONE: no protection.
    assert.equal(
      completedByOther(
        asComments([
          claimLine('b', 1700000005000),
          doneLine('a', 1700000003000),
        ]),
        'b',
      )?.agent,
      'a',
    )
    // and the reverse stays protected
    assert.equal(
      completedByOther(
        asComments([
          claimLine('b', 1700000001000),
          doneLine('a', 1700000003000),
        ]),
        'b',
      ),
      null,
    )
  })

  it('reads `at` from the body field, falls back to created_at, and fences with neither', () => {
    const fromField = completedByOther(
      [{ body: doneLine('a', 1600000000000), created_at: 'ignored' }],
      'b',
    )
    assert.equal(fromField.at, 1600000000000)
    const fromMeta = completedByOther(
      [{ body: '**DONE** | agent: agent-a', created_at: 1650000000000 }],
      'b',
    )
    assert.equal(fromMeta.at, 1650000000000)
    const bare = completedByOther(
      asComments(['**DONE** | agent: agent-a']),
      'b',
    )
    assert.equal(bare.at, null)
    assert.equal(
      bare.agent,
      'a',
      'a timestamp-less DONE still fences; it only loses the stamp',
    )
  })
})

// Verb arms: the harness mirrors done-attestation.test.js, whose discipline is that a refusal
// writes NOTHING (a refusal that has commented is not a refusal). `viewIssue` echoes the lines
// this process already posted, so the post-write self-checks see a live timeline, and a scripted
// BASE array models the move-under-the-read. Box 3's critical-path claim is pinned by counting
// the viewIssue reads INSIDE the verb - the fence must consume them, not any earlier snapshot.
const BODY =
  '## Goal\ng\n\n## Done when\n- [x] all ticked\n\n## Files\nsrc/foo.js\n'

const build = (base, { agent = 'bravo' } = {}) => {
  const posted = []
  // a SCRIPTED build takes an array of per-read timelines ([[first], [second]]); a plain one
  // repeats the same timeline on every read
  const scripts = (Array.isArray(base[0]) ? base : [base]).map(asComments)
  let call = 0
  let reads = 0
  const github = {
    issueKind: async () => ({ isPullRequest: false }),
    viewIssue: async () => {
      reads += 1
      const timeline = [
        ...scripts[Math.min(call, scripts.length - 1)],
        ...posted.map((body) => ({ body })),
      ]
      call += 1
      return { number: 60, body: BODY, labels: [], comments: timeline }
    },
    listIssues: async () => [
      { number: 60, body: BODY, labels: [], comments: [] },
    ],
    commentIssue: async (num, text) => {
      posted.push(text)
    },
    editIssue: async () => {},
    closeIssue: async () => {},
  }
  const coord = CoordService({
    github,
    agent,
    human: 'Sullux',
    now: () => 1700000005000,
  })
  return { coord, posted, reads: () => reads }
}

const COMPLETED = [claimLine('delta'), doneLine('delta')]

describe('claim (the #96 fence on the critical path)', () => {
  it('refuses an issue another agent already DONE-d, names the stamp, writes nothing', async () => {
    const { coord, posted, reads } = build(COMPLETED, { agent: 'bravo' })
    const res = await coord.claim(60, { plan: 'p' })
    assert.equal(res.ok, false)
    assert.match(res.error, /unretracted \*\*DONE\*\* by agent-delta/)
    assert.match(
      res.error,
      /2023-11-14T22:13:20\.000Z/,
      'box 1: names agent AND timestamp',
    )
    assert.match(res.error, /RELEASE/, 'and the only retraction path is stated')
    assert.deepEqual(posted, [], 'a refusal writes NOTHING')
    assert.equal(
      reads(),
      1,
      'the fence consumed the inside-the-call read - once, before any write',
    )
  })

  it('still lets B claim once the COMPLETER releases - same timeline plus one line (box 4 selectivity)', async () => {
    const { coord, posted } = build([...COMPLETED, releaseLine('delta')], {
      agent: 'bravo',
    })
    const res = await coord.claim(60, { plan: 'p' })
    assert.equal(res.ok, true, res.error)
    assert.match(
      posted[0],
      /^\*\*CLAIM\*\* \| agent: agent-bravo/,
      'the success path still posts',
    )
  })

  it('auto-releases when the DONE landed mid-write even though the pre-read could not see it', async () => {
    // pre-read: nothing. post-write refresh: my CLAIM (stamped 5s) AND delta's DONE (stamped 3s -
    // it ARRIVED before my line landed, after my read). Stamps must beat array order here.
    const { coord, posted } = build([[], [doneLine('delta', 1700000003000)]], {
      agent: 'bravo',
    })
    const res = await coord.claim(60, { plan: 'p' })
    assert.equal(res.ok, false)
    assert.match(res.error, /between the read and the write/)
    assert.equal(
      posted.length,
      2,
      'CLAIM then an automatic RELEASE, nothing else',
    )
    assert.match(posted[1], /^\*\*RELEASE\*\* \| agent: agent-bravo/)
    assert.match(posted[1], /completed this before my claim landed \(#96\)/)
  })
})

describe('done (the #96 fence before every other gate)', () => {
  it('refuses over an unretracted DONE even while holding a bug-acquired claim, and offers the credit-only path', async () => {
    // #1212 exactly: bravo's claim was ACCEPTED by the pre-fix tool after delta's DONE, so the
    // #28 branch would have passed him - the fence must run FIRST and refuse anyway.
    const { coord, posted, reads } = build(
      [doneLine('delta'), claimLine('bravo', 1700000001000)],
      { agent: 'bravo' },
    )
    const res = await coord.done(60, { text: 'my table' })
    assert.equal(res.ok, false)
    assert.match(res.error, /recorded done by agent-delta/)
    assert.match(
      res.error,
      /Credit-only path/,
      'box 2: suggests comment-not-close',
    )
    assert.match(res.error, /--force/, 'and names the supervisor escape')
    assert.deepEqual(posted, [], 'and refuses with zero side effects')
    assert.equal(reads(), 1, 'inside-the-call read gates the write')
  })

  it('--force closes AND records the override in the DONE line and the result (box 5)', async () => {
    const { coord, posted } = build(COMPLETED, { agent: 'bravo' })
    const res = await coord.done(60, { force: true })
    assert.equal(res.ok, true)
    assert.match(
      posted[0],
      /forced over unretracted DONE by agent-delta/,
      'the override is visible in the comment the verb writes',
    )
    assert.equal(
      res.forcedOverDone,
      'delta',
      'and one field over in the return',
    )
  })

  it('the completer re-closing their own issue needs neither force nor a note', async () => {
    const { coord, posted } = build(COMPLETED, { agent: 'delta' })
    const res = await coord.done(60, {})
    assert.equal(res.ok, true, res.error)
    assert.doesNotMatch(
      posted[0],
      /forced over/,
      'self-closing is not an override, so it must not read like one',
    )
  })
})
