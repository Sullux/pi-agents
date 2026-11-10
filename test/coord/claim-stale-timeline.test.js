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
const handoffLine = (to, from = 'c', at = 1699999500000) =>
  `**HANDOFF** | agent: agent-${from} | to: agent-${to} | at: ${at}`
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

  it('a HANDOFF to me protects the close, the same way a prior CLAIM does (bravo ask 2)', () => {
    // The asymmetry bravo named: `applyMarker` counts a handoff as ownership, but the fence read
    // only CLAIM, so the agent who was HANDED the issue was fenced by a bystander's DONE while a
    // CLAIMer in the identical position was protected - and because the fence runs before #28's
    // ownership branch in `done`, `--force` was the only exit. Both arms below are load-bearing:
    // the first says the semantics, the second says a handoff to SOMEONE ELSE is not a hold on me.
    assert.equal(
      completedByOther(
        asComments([handoffLine('b'), doneLine('a', 1700000003000)]),
        'b',
      ),
      null,
      'handed the issue, then a bystander closed it: still mine to close',
    )
    assert.equal(
      completedByOther(
        asComments([handoffLine('d'), doneLine('a', 1700000003000)]),
        'b',
      )?.agent,
      'a',
      'a handoff to a third party must not protect me - this is the arm that stops the rule widening to any line containing a `to:`',
    )
    assert.equal(
      completedByOther(
        asComments([
          handoffLine('b'),
          doneLine('a', 1700000003000),
          releaseLine('b'),
        ]),
        'b',
      )?.agent,
      'a',
      'and standing down re-applies the fence, exactly as it does for a CLAIM',
    )
  })

  it('the fallback reads the GraphQL field live, so an unstamped DONE still fences on real bytes', () => {
    // Ask 1's transport bug: `viewIssue` is `gh issue view --json comments`, whose comment objects
    // carry `createdAt`. A `created_at`-only fallback made the whole branch dead in production and
    // arm 9 was pinning a field nobody sends. These objects are the LIVE shape.
    const live = (body, createdAt) => ({ body, createdAt })
    const fence = completedByOther(
      [live('**DONE** | agent: agent-a | pr: #1', '2026-11-10T04:00:00Z')],
      'b',
    )
    assert.equal(fence.agent, 'a', 'an unstamped live DONE still fences')
    assert.equal(
      fence.at,
      Date.parse('2026-11-10T04:00:00Z'),
      'and the live ISO stamp is COERCED to ms, because the ordering rule compares numbers',
    )
    assert.equal(
      completedByOther(
        [
          live(`**CLAIM** | agent: agent-b | at: ${1700000009000}`),
          live('**DONE** | agent: agent-a', '2026-11-10T04:00:00Z'),
        ],
        'b',
      ),
      null,
      'mixed shapes (a stamped claim, a stampless DONE) cannot order themselves, so protection defaults to the claimant',
    )
  })

  it('EQUAL stamps fall back to line order, so the fence cannot disagree with the fold (#100 x #102 seam)', () => {
    // Two tool writes inside one millisecond are not hypothetical: the #102 fixture bytes freeze a
    // 12-second pair, and `at:` is emitted by `now()` at ms resolution, so a same-ms race is the
    // shape that repeats. Before this arm the fence compared `<` only, so BOTH orders refused my
    // close while `applyMarker` - earliest CLAIM wins, array order deciding the tie - named me the
    // holder in one of them. One timeline, two answers, same file: the recorded "a tool can both
    // take a claim and refuse it" divergence, arriving inside one module.
    const tie = 1700000003000
    assert.equal(
      completedByOther(
        asComments([claimLine('b', tie), doneLine('a', tie)]),
        'b',
      ),
      null,
      'my claim is the earlier LINE under the same stamp, so Rule C makes me the holder and the fence must not overrule it',
    )
    assert.equal(
      completedByOther(
        asComments([doneLine('a', tie), claimLine('b', tie)]),
        'b',
      )?.agent,
      'a',
      'reversed order, same stamps: my claim arrived after the completion, so the fence stands - this is the arm that makes the tie-break a rule rather than a coincidence',
    )
    // and the fold agrees in both directions, which is the whole point of the seam
    const { ownerOf } = require('../../src/coord/owner')
    assert.equal(
      ownerOf({ comments: [{ body: claimLine('b', tie) }, { body: doneLine('a', tie) }] }),
      'b',
      'earliest CLAIM wins the holder slot under a tie',
    )
    assert.equal(
      ownerOf({ comments: [{ body: doneLine('a', tie) }, { body: claimLine('b', tie) }] }),
      'b',
      'the fold is order-blind for a CLAIM that is the only claim, so ownership and the fence can only agree by the fence deferring to line order',
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
