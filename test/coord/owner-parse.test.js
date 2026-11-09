const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const {
  agentOf,
  ownerOf,
  isMine,
  hasClaimBy,
  unresolvedProtocolLines,
} = require('../../src/coord/owner')

// #49: a CLAIM whose identity field does not parse resolved to no owner at all, which freed
// the issue in the scope gate (`checkScopeCollision` does `if (!owner) continue`) and locked
// its author out of `done` (the escape hatch is `owner === '' && hasClaimBy(...)`, and
// hasClaimBy shared the same broken parser). Every arm below carries a witness that the case
// it exercises was UNREACHABLE by the strict `| agent:` form, so a regression that drops the
// fallback cannot pass silently.

const STRICT = /\|\s*agent:\s*[^|\n]+/
const comment = (...bodies) => bodies.map((body) => ({ body }))
const issue = (...bodies) => ({ comments: comment(...bodies) })

describe('owner.js: identity-field parsing (#49)', () => {
  it('the tool-authored shape still resolves, and is not re-parsed by the fallback', () => {
    const body =
      '**CLAIM** | agent: agent-delta | human: @Sullux | at: 1700000000000'
    assert.match(body, STRICT)
    assert.equal(agentOf(body), 'delta')
    assert.equal(ownerOf(issue(body)), 'delta')
    assert.equal(isMine(issue(body), 'agent-Delta'), true)
  })

  it('an extra |-field before the agent field resolves to the claimer', () => {
    const body =
      '**CLAIM** | ref: "agent: agent-echo" | agent: agent-delta | at: 1'
    assert.equal(agentOf(body), 'delta')
    assert.equal(ownerOf(issue(body)), 'delta')
  })

  it('the agent field on a continuation line resolves (#49 probe row two)', () => {
    const body =
      '**CLAIM** | ref: "agent: agent-echo"\nagent: agent-delta | at: 1'
    assert.equal(
      body.match(STRICT),
      null,
      'witness: the strict form cannot match this body, so the fallback must travel',
    )
    assert.equal(agentOf(body), 'delta')
    assert.equal(ownerOf(issue(body)), 'delta')
    assert.equal(isMine(issue(body), 'agent-Bravo'), false)
  })

  it('a pipe-less agent field resolves (#49 probe row three)', () => {
    const body = '**CLAIM** agent: agent-delta | at: 1'
    assert.equal(
      body.match(STRICT),
      null,
      'witness: no pipe precedes the field, so this is the fallback path',
    )
    assert.equal(agentOf(body), 'delta')
    assert.equal(ownerOf(issue(body)), 'delta')
  })

  it('a quoted peer claim AFTER the real field cannot steal ownership', () => {
    // strict-first ordering is the safety property: the poster's field is matched before any
    // prose mention, so a body quoting another agent stays attributed to its author.
    const body =
      '**CLAIM** | agent: agent-delta | at: 1\nnote: charlie wrote **CLAIM** | agent: agent-charlie here first'
    assert.equal(agentOf(body), 'delta')
    assert.equal(ownerOf(issue(body)), 'delta')
    assert.equal(hasClaimBy(comment(body), 'agent-Charlie'), false)
  })

  it('prose that merely quotes a protocol line is not a marker at all', () => {
    const body =
      '## I need to correct this issue\nthe CLAIM here reads `**CLAIM** | agent: ${agent}` at :40'
    assert.equal(ownerOf(issue(body)), '')
    assert.deepEqual(unresolvedProtocolLines(comment(body)), [])
  })
})

describe('owner.js: an unreadable identity cannot free the issue (#49)', () => {
  it('a CLAIM with no recoverable agent keeps the existing holder', () => {
    const timeline = issue(
      '**CLAIM** | agent: agent-delta | at: 1',
      '**CLAIM** | ref: nothing-parseable',
    )
    assert.equal(
      agentOf(timeline.comments[1].body),
      '',
      'precondition: this line really is unresolvable',
    )
    assert.equal(ownerOf(timeline), 'delta')
    assert.equal(isMine(timeline, 'agent-Bravo'), false)
  })

  it('a HANDOFF whose to: field does not parse keeps the holder instead of clearing', () => {
    const timeline = issue(
      '**CLAIM** | agent: agent-delta | at: 1',
      '**HANDOFF** | see the thread\nhandoff to someone later',
    )
    assert.equal(ownerOf(timeline), 'delta')
  })

  it('a readable HANDOFF still moves ownership, and a RELEASE still clears', () => {
    assert.equal(
      ownerOf(
        issue(
          '**CLAIM** | agent: agent-delta',
          '**HANDOFF** | to: @agent-charlie | reason: switching tasks',
        ),
      ),
      'charlie',
    )
    assert.equal(
      ownerOf(
        issue(
          '**CLAIM** | agent: agent-delta',
          '**RELEASE** | lost claim race to agent-bravo',
        ),
      ),
      '',
      'the documented unattributed-close-out clears: race.js relies on it and three pins do too',
    )
    assert.equal(
      ownerOf(issue('**CLAIM** | agent: agent-delta', '**DONE** | pr: #123')),
      '',
    )
  })

  it('a first-comment CLAIM with no identity is still unresolved, not invented', () => {
    const timeline = issue('**CLAIM** | ref: nothing-parseable')
    assert.equal(ownerOf(timeline), '')
    assert.equal(
      unresolvedProtocolLines(timeline.comments).length,
      1,
      'the residual case must be nameable, not silent',
    )
  })
})

describe('owner.js: unresolvedProtocolLines is a real witness', () => {
  it('returns empty when every marker resolves - and fires on the shapes that do not', () => {
    const good = issue(
      '**CLAIM** | agent: agent-delta',
      '**RELEASE** | agent: agent-delta',
    )
    assert.deepEqual(unresolvedProtocolLines(good.comments), [])
    assert.equal(
      unresolvedProtocolLines(good.comments).length,
      0,
      'floor above: the same function must be able to return nonzero, which the arm below shows',
    )
    const bad = issue('**CLAIM** | ref: nope', '**HANDOFF** | no target field')
    assert.deepEqual(unresolvedProtocolLines(bad.comments), [
      '**CLAIM** | ref: nope',
      '**HANDOFF** | no target field',
    ])
  })

  it('ignores RELEASE/DONE lines, whose unattributed form is intentionally clearing', () => {
    assert.deepEqual(
      unresolvedProtocolLines(issue('**RELEASE** | lost the race').comments),
      [],
    )
    assert.deepEqual(
      unresolvedProtocolLines(issue('**DONE** | pr: #9').comments),
      [],
    )
  })
})

describe('owner.js: hasClaimBy sees the author for every shape ownerOf resolves (#49)', () => {
  it('the done-guard escape hatch works without --force on a hand-authored claim', () => {
    const timeline = issue(
      '**CLAIM** | ref: "agent: agent-echo"\nagent: agent-delta | at: 1',
    )
    const body = timeline.comments[0].body
    assert.equal(
      hasClaimBy(timeline.comments, 'agent-Delta'),
      true,
      'this is the #28 escape hatch: owner === "" && hasClaimBy(...) - it was false before #49',
    )
    assert.equal(ownerOf(timeline), 'delta')
    assert.equal(agentOf(body), 'delta')
  })

  it('a bystander never resolves hasClaimBy for a claim they did not sign', () => {
    const timeline = issue('**CLAIM** | agent: agent-delta')
    assert.equal(hasClaimBy(timeline.comments, 'agent-Bravo'), false)
    assert.equal(hasClaimBy(timeline.comments, 'agent-Delta'), true)
  })
})
