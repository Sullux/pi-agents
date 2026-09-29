const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { cleanAgent, ownerOf, isMine } = require('../../src/coord/owner')
const { parseScope, checkScopeCollision } = require('../../src/coord/scope')
const { evaluateClaimRace } = require('../../src/coord/race')

describe('Coordination Engine: Owner Resolution', () => {
  it('cleanAgent normalizes agent callsigns', () => {
    assert.equal(cleanAgent('pi/agent-alpha'), 'alpha')
    assert.equal(cleanAgent('@alpha'), 'alpha')
    assert.equal(cleanAgent('agent-delta '), 'delta')
    assert.equal(cleanAgent('foxtrot'), 'foxtrot')
  })

  it('ownerOf determines ownership from protocol comments', () => {
    const issueWithClaim = {
      comments: [
        { body: 'regular discussion comment' },
        { body: '**CLAIM** | agent: agent-alpha | human: @Sullux | at: 2026-09-27T10:00:00Z\n\nplan: fix' },
      ],
    }
    assert.equal(ownerOf(issueWithClaim), 'alpha')

    const issueWithRelease = {
      comments: [...issueWithClaim.comments, { body: '**RELEASE** | lost claim race to agent-bravo' }],
    }
    assert.equal(ownerOf(issueWithRelease), '')

    const issueWithHandoff = {
      comments: [...issueWithClaim.comments, { body: '**HANDOFF** | to: @agent-charlie | reason: switching tasks' }],
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
    assert.equal(isMine(issue, 'pi/echo'), true)
    assert.equal(isMine(issue, 'delta'), false)
  })
})

describe('Coordination Engine: Scope & Collisions', () => {
  it('parseScope extracts declared Files from issue body', () => {
    const bodyWithFiles = '## Goal\nfoo\n\n## Files\nsrc/server/routes.js\nsrc/client/app.js\n\n## Notes'
    assert.deepEqual(parseScope(bodyWithFiles), ['src/server/routes.js', 'src/client/app.js'])

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
})
