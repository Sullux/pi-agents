const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { checkScopeCollision, parseScope } = require('../../src/coord/scope')

// #76: the gate's `if (!owner || owner === cleanCurrent) continue` skipped an issue with no CLAIM
// comment out of the collision scan entirely, so two agents could claim the same CONCRETE path in
// the same minute and neither got warned - the pitcairn pair #1171 / #1179 (both open, both
// declaring test/style-debt.mjs, both unclaimed at 2026-11-09T20:30Z) is the live witness. The
// fix makes an unheld overlap RETURN as a warning, never as a refusal: nobody has committed to it,
// and fencing on a bare declaration would freeze exactly the work the board calls free.
//
// The pair below is the whole defect in two calls: identical files, identical claimant, and only
// the presence of a CLAIM line differs. If both arms ever return the same shape, this file is
// lying and should be deleted rather than extended.

const SHARED = 'test/style-debt.mjs'
const TARGET_BODY = `## Files\n${SHARED}\nsrc/x.js`
const PEER_BODY = `## Files\n${SHARED}\npublic/y.css`
const TARGET_FILES = [SHARED, 'src/x.js']
const CLAIM = (agent) =>
  `**CLAIM** | agent: agent-${agent} | human: @Sullux | at: 1794256631855`

const issue = (number, body, comments = [], labels = []) => ({
  number,
  body,
  comments,
  labels,
})
const target = (number = 1171, body = TARGET_BODY) => ({
  number,
  body,
  labels: [],
  comments: [],
})

describe('scope gate #76: an unclaimed open issue with a shared concrete path warns instead of vanishing', () => {
  it('the pair that used to be silent now returns exactly one warning, and still does not refuse', () => {
    const res = checkScopeCollision(
      TARGET_FILES,
      [issue(1179, PEER_BODY)],
      'bravo',
      target(),
    )

    assert.equal(
      res.hasCollision,
      false,
      'an unheld overlap must not fence - nobody owns it yet',
    )
    assert.equal(res.warnings.length, 1, 'and it must not be silent either')
    assert.equal(res.warnings[0].issue, 1179)
    assert.equal(
      res.warnings[0].status,
      'unclaimed',
      'statusOf has no label here, so the fallback names it',
    )
    assert.equal(
      res.warnings[0].agent,
      'nobody',
      'the warning says plainly that no holder exists',
    )
    assert.equal(
      res.warnings[0].unheld,
      true,
      'so a renderer can phrase the advice differently later',
    )
    assert.deepEqual(
      res.warnings[0].files,
      [SHARED],
      'the warning names the shared path, not just the issue',
    )
  })

  it('the IDENTICAL pair with a CLAIM still hard-refuses, which is the arm that makes the one above a measurement', () => {
    const held = issue(1179, PEER_BODY, [{ body: CLAIM('delta') }])
    const res = checkScopeCollision(TARGET_FILES, [held], 'bravo', target())

    assert.equal(
      res.hasCollision,
      true,
      'a held overlap is unchanged: it fences',
    )
    assert.equal(res.collidingIssue, 1179)
    assert.equal(res.collidingAgent, 'delta')
    assert.deepEqual(res.collidingFiles, [SHARED])
  })

  it('non-vacuity floor: a disjoint unclaimed neighbour produces no warning at all', () => {
    const disjoint = issue(
      1179,
      '## Files\npublic/styles/booking.css\nsrc/unrelated.js',
    )
    const res = checkScopeCollision(TARGET_FILES, [disjoint], 'bravo', target())

    assert.equal(
      res.warnings.length,
      0,
      'otherwise every claim would warn and the signal is worthless',
    )
    assert.equal(res.hasCollision, false)
  })

  it('the claiming issue never warns about itself, even though it is unheld by definition', () => {
    // Callers pass the full open set, so the target is usually IN it. With unheld issues now
    // visible, an unguarded loop would make every unclaimed claim warn about its own files.
    const self = issue(1171, TARGET_BODY)
    const res = checkScopeCollision(TARGET_FILES, [self], 'bravo', target())

    assert.equal(res.warnings.length, 0, 'a self-overlap is not a collision')
    assert.equal(res.hasCollision, false)
  })

  it('a split: line waives the unheld pair too, so the existing protocol exit still governs', () => {
    const waiving = target(1171, `## Files\n${SHARED}\nsrc/x.js\nsplit: #1179`)
    const res = checkScopeCollision(
      TARGET_FILES,
      [issue(1179, PEER_BODY)],
      'bravo',
      waiving,
    )

    assert.equal(
      res.warnings.length,
      0,
      'the waiver is declared, so the pair is settled by protocol',
    )
    assert.equal(res.hasCollision, false)
  })

  it('a hard refusal does not swallow the warnings: both halves can fire in one pass', () => {
    const unheld = issue(1179, PEER_BODY)
    const held = issue(
      1170,
      PEER_BODY,
      [{ body: CLAIM('charlie') }],
      [{ name: 'status:claimed' }],
    )
    const res = checkScopeCollision(
      TARGET_FILES,
      [unheld, held],
      'bravo',
      target(),
    )

    assert.equal(res.hasCollision, true, 'the held one still fences')
    assert.equal(res.collidingIssue, 1170)
    assert.equal(
      res.warnings.length,
      1,
      'and the unheld one is still reported rather than lost',
    )
    assert.equal(res.warnings[0].issue, 1179)
  })

  it('glob-vs-concrete stays invisible, deliberately: this issue is the ownerless skip, not #896', () => {
    // Pinned as CURRENT behaviour so a future glob-matching fix is a deliberate edit here instead
    // of a silent widening. Expanding a glob to concrete paths is a different decision and would
    // make every claim warn about every directory-declared issue, which is not this contract.
    const globPeer = issue(1180, '## Files\nsrc/**')
    const res = checkScopeCollision(['src/x.js'], [globPeer], 'bravo', target())

    assert.equal(res.warnings.length, 0)
    assert.ok(
      !parseScope(globPeer.body).includes('src/x.js'),
      'the premise: a glob never matches a concrete path',
    )
  })
})
