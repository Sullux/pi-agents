const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { cleanAgent, ownerOf, isMine } = require('../../src/coord/owner')
const { parseScope, checkScopeCollision } = require('../../src/coord/scope')
const { evaluateClaimRace, liveClaims } = require('../../src/coord/race')

describe('Coordination Engine: Owner Resolution', () => {
  it('cleanAgent normalizes agent callsigns', () => {
    assert.equal(cleanAgent('pi/agent-alpha'), 'alpha')
    assert.equal(cleanAgent('@alpha'), 'alpha')
    assert.equal(cleanAgent('agent-delta '), 'delta')
    assert.equal(cleanAgent('foxtrot'), 'foxtrot')
    assert.equal(cleanAgent('Delta'), 'delta')
    assert.equal(cleanAgent('agent-Delta'), 'delta')
  })

  it('ownerOf determines ownership from protocol comments', () => {
    const issueWithClaim = {
      comments: [
        { body: 'regular discussion comment' },
        {
          body: '**CLAIM** | agent: agent-alpha | human: @Sullux | at: 2026-09-27T10:00:00Z\n\nplan: fix',
        },
      ],
    }
    assert.equal(ownerOf(issueWithClaim), 'alpha')

    const issueWithRelease = {
      comments: [
        ...issueWithClaim.comments,
        { body: '**RELEASE** | lost claim race to agent-bravo' },
      ],
    }
    assert.equal(ownerOf(issueWithRelease), '')

    const issueWithHandoff = {
      comments: [
        ...issueWithClaim.comments,
        { body: '**HANDOFF** | to: @agent-charlie | reason: switching tasks' },
      ],
    }
    assert.equal(ownerOf(issueWithHandoff), 'charlie')

    const issueWithDone = {
      comments: [...issueWithHandoff.comments, { body: '**DONE** | pr: #123' }],
    }
    assert.equal(ownerOf(issueWithDone), '')
  })

  it('isMine correctly checks caller ownership against protocol comments', () => {
    const issue = {
      comments: [{ body: '**CLAIM** | agent: pi/agent-echo | human: @Sullux' }],
    }
    assert.equal(isMine(issue, 'agent-echo'), true)
    assert.equal(isMine(issue, 'echo'), true)
    assert.equal(isMine(issue, 'Echo'), true)
    assert.equal(isMine(issue, 'pi/Echo'), true)
    assert.equal(isMine(issue, 'delta'), false)
  })
})

describe('Coordination Engine: Scope & Collisions', () => {
  it('parseScope extracts declared Files from issue body', () => {
    const bodyWithFiles =
      '## Goal\nfoo\n\n## Files\nsrc/server/routes.js\nsrc/client/app.js\n\n## Notes'
    assert.deepEqual(parseScope(bodyWithFiles), [
      'src/server/routes.js',
      'src/client/app.js',
    ])

    const bodyWithoutFiles = '## Goal\nfoo\n\n## Files\n_(none listed)_\n'
    assert.deepEqual(parseScope(bodyWithoutFiles), [])

    const emptyBody = '## Goal\nno files section here'
    assert.deepEqual(parseScope(emptyBody), [])
  })

  it('checkScopeCollision detects file overlaps with active peer claims', () => {
    const activeIssues = [
      {
        number: 101,
        body: '## Files\nsrc/server/routes.js\nsrc/db.js',
        comments: [{ body: '**CLAIM** | agent: agent-alpha' }],
      },
      {
        number: 102,
        body: '## Files\nsrc/client/main.js',
        comments: [{ body: '**CLAIM** | agent: agent-bravo' }],
      },
    ]

    const targetScopeOverlap = ['src/server/routes.js', 'src/utils.js']
    const clash = checkScopeCollision(targetScopeOverlap, activeIssues, 'delta')
    assert.equal(clash.hasCollision, true)
    assert.equal(clash.collidingIssue, 101)
    assert.equal(clash.collidingAgent, 'alpha')
    assert.equal(clash.collidingFile, 'src/server/routes.js')

    const targetScopeClean = ['src/utils.js']
    const clean = checkScopeCollision(targetScopeClean, activeIssues, 'delta')
    assert.equal(clean.hasCollision, false)
  })
})

describe('Coordination Engine: Race Arbitration', () => {
  const claim = (id, createdAt, agent) => ({
    id,
    createdAt,
    body: `**CLAIM** | agent: agent-${agent} | human: @Sullux`,
  })
  const terminating = (kind) => (id, createdAt, agent) => ({
    id,
    createdAt,
    body: `**${kind}** | agent: agent-${agent} | reason: test`,
  })
  const release = terminating('RELEASE')
  const done = terminating('DONE')
  const handoff = terminating('HANDOFF')

  it('detects if peer claimed earlier in a simultaneous race', () => {
    const comments = [
      {
        id: 'c1',
        createdAt: '2026-09-27T10:00:15Z',
        body: '**CLAIM** | agent: agent-alpha | human: @Sullux',
      },
      {
        id: 'c2',
        createdAt: '2026-09-27T10:00:19Z',
        body: '**CLAIM** | agent: agent-bravo | human: @Sullux',
      },
    ]

    const bravoResult = evaluateClaimRace(comments, 'bravo')
    assert.equal(bravoResult.won, false)
    assert.equal(bravoResult.earlierAgent, 'alpha')

    const alphaResult = evaluateClaimRace(comments, 'alpha')
    assert.equal(alphaResult.won, true)
  })

  it('a RELEASEd claim stops blocking later claimants (#800 orphaned a p1 this way)', () => {
    // pitcairn-portal#800's real timeline: bravo claimed, released 7 minutes later,
    // and delta's claim an hour after that was refused as a lost "simultaneous" race.
    const comments = [
      claim('c1', '2026-10-26T17:44:19Z', 'bravo'),
      release('c2', '2026-10-26T17:51:12Z', 'bravo'),
      claim('c3', '2026-10-26T18:39:03Z', 'delta'),
    ]

    assert.deepEqual(
      liveClaims(comments).map((c) => c.agent),
      ['delta'],
    )
    assert.equal(evaluateClaimRace(comments, 'delta').won, true)
    // the release is symmetric: bravo no longer holds it either
    const bravoResult = evaluateClaimRace(comments, 'bravo')
    assert.equal(bravoResult.won, false)
    assert.equal(bravoResult.earlierAgent, 'delta')
  })

  it('arbitrates on the earliest LIVE claim, not the earliest ever', () => {
    const comments = [
      claim('c1', '2026-09-27T10:00:00Z', 'alpha'),
      release('c2', '2026-09-27T10:00:10Z', 'alpha'),
      claim('c3', '2026-09-27T10:00:20Z', 'bravo'),
      claim('c4', '2026-09-27T10:00:30Z', 'delta'),
    ]

    assert.equal(evaluateClaimRace(comments, 'bravo').won, true)
    const deltaResult = evaluateClaimRace(comments, 'delta')
    assert.equal(deltaResult.won, false)
    assert.equal(deltaResult.earlierAgent, 'bravo')
    assert.equal(evaluateClaimRace(comments, 'alpha').earlierAgent, 'bravo')
  })

  it('DONE and HANDOFF release a claim exactly like RELEASE does', () => {
    const afterDone = [
      claim('c1', '2026-09-27T10:00:00Z', 'alpha'),
      done('c2', '2026-09-27T10:00:10Z', 'alpha'),
      claim('c3', '2026-09-27T10:00:20Z', 'bravo'),
    ]
    assert.equal(evaluateClaimRace(afterDone, 'bravo').won, true)

    const afterHandoff = [
      claim('c1', '2026-09-27T10:00:00Z', 'alpha'),
      handoff('c2', '2026-09-27T10:00:10Z', 'alpha'),
      claim('c3', '2026-09-27T10:00:20Z', 'bravo'),
    ]
    assert.equal(evaluateClaimRace(afterHandoff, 'bravo').won, true)
  })

  it('a STATUS or discussion comment does not terminate a claim', () => {
    // #800 also carries `**STATUS** - agent-bravo, claimed.` between the claim and
    // the release; treating every protocol-looking marker as a terminator would
    // disarm a claimant who merely posted progress.
    const comments = [
      claim('c1', '2026-09-27T10:00:00Z', 'alpha'),
      {
        id: 'c2',
        createdAt: '2026-09-27T10:00:05Z',
        body: '**STATUS** - agent-alpha, claimed. Findings so far...',
      },
      { id: 'c3', createdAt: '2026-09-27T10:00:06Z', body: 'plain discussion' },
      claim('c4', '2026-09-27T10:00:10Z', 'bravo'),
    ]

    assert.deepEqual(
      liveClaims(comments).map((c) => c.agent),
      ['alpha', 'bravo'],
    )
    assert.equal(evaluateClaimRace(comments, 'alpha').won, true)
    assert.equal(evaluateClaimRace(comments, 'bravo').earlierAgent, 'alpha')
  })

  it('an agent that releases then re-claims is live again from the re-claim', () => {
    const reclaimed = [
      claim('c1', '2026-09-27T10:00:00Z', 'alpha'),
      release('c2', '2026-09-27T10:00:10Z', 'alpha'),
      claim('c3', '2026-09-27T10:00:30Z', 'alpha'),
      claim('c4', '2026-09-27T10:00:40Z', 'bravo'),
    ]
    assert.equal(evaluateClaimRace(reclaimed, 'alpha').won, true)

    // ...but a peer who claimed inside the gap keeps it: alpha's re-claim is later
    const lostTheGap = [
      claim('c1', '2026-09-27T10:00:00Z', 'alpha'),
      release('c2', '2026-09-27T10:00:10Z', 'alpha'),
      claim('c3', '2026-09-27T10:00:20Z', 'bravo'),
      claim('c4', '2026-09-27T10:00:30Z', 'alpha'),
    ]
    assert.equal(evaluateClaimRace(lostTheGap, 'alpha').won, false)
    assert.equal(evaluateClaimRace(lostTheGap, 'alpha').earlierAgent, 'bravo')
  })

  it('breaks a same-instant tie by comment id (Rule C)', () => {
    const sameInstant = '2026-09-27T10:00:00Z'
    // deliberately listed out of order: the sort, not the array, must decide
    const comments = [
      claim('c9', sameInstant, 'zulu'),
      claim('c1', sameInstant, 'bravo'),
    ]

    assert.deepEqual(
      liveClaims(comments).map((c) => c.id),
      ['c1', 'c9'],
    )
    assert.equal(evaluateClaimRace(comments, 'bravo').won, true)
    assert.equal(evaluateClaimRace(comments, 'zulu').earlierAgent, 'bravo')
  })

  it('a timeline with no live claims cannot lose a race', () => {
    const allReleased = [
      claim('c1', '2026-09-27T10:00:00Z', 'alpha'),
      release('c2', '2026-09-27T10:00:10Z', 'alpha'),
    ]

    assert.deepEqual(liveClaims(allReleased), [])
    assert.equal(evaluateClaimRace(allReleased, 'delta').won, true)
    assert.equal(evaluateClaimRace([], 'delta').won, true)
  })
})
