const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { completedByOther } = require('../../src/coord/owner')

// #167 box 3: the arbitration consumer is format-proof. completedByOther decides Rule C
// protection from the `at:` stamps; these arms pin that a refused token never participates
// as a fake number, and that epoch + full ISO order correctly on one axis (box 4 option a).
const claim = (at, createdAt) => ({
  body: `**CLAIM** | agent: agent-bravo | at: ${at}`,
  createdAt,
})
const done = (at, createdAt) => ({
  body: `**DONE** | agent: agent-delta | at: ${at}`,
  createdAt,
})

describe('#167 Rule C ordering across stamp formats', () => {
  it('epoch-ms: an earlier claim protects, a later claim does not', () => {
    // my claim 1000 < delta done 2000 -> protected -> no fence
    assert.equal(
      completedByOther([claim('1000', 1000), done('2000', 2000)], 'bravo'),
      null,
    )
    // my claim 3000 > delta done 2000 -> not protected -> fence stands
    const fence = completedByOther(
      [claim('3000', 3000), done('2000', 2000)],
      'bravo',
    )
    assert.equal(fence.agent, 'delta')
  })

  it('full ISO 8601 orders against epoch on the same millisecond axis', () => {
    const earlyIso = '2026-10-26T15:58:04Z' // Date.parse -> a real instant
    const earlyMs = Date.parse(earlyIso)
    // my ISO claim BEFORE delta's epoch done -> protected
    assert.equal(
      completedByOther(
        [
          claim(earlyIso, earlyMs),
          done(String(earlyMs + 5000), earlyMs + 5000),
        ],
        'bravo',
      ),
      null,
    )
    // my ISO claim AFTER delta's epoch done -> fence stands
    const fence = completedByOther(
      [claim(earlyIso, earlyMs), done(String(earlyMs - 5000), earlyMs - 5000)],
      'bravo',
    )
    assert.equal(fence.agent, 'delta')
  })

  it('THE TRAP: a date-less HH:MMZ claim stamp is refused, not read as epoch 20', () => {
    // Old regex read `at: 20:16Z` as Number('20') = 20, so myClaimAt(20) < doneAt(1795...)
    // made protectedByPriorClaim TRUE and returned null - a malformed stamp WON protection.
    // Now the token is refused and ordering falls back to the comment's createdAt, which here
    // is AFTER the done, so the fence correctly stands. This arm is RED on the old parser.
    const doneAt = 1795290865225
    const fence = completedByOther(
      [claim('20:16Z', doneAt + 60000), done(String(doneAt), doneAt)],
      'bravo',
    )
    assert.equal(fence?.agent, 'delta')
    assert.equal(fence?.protectedByPriorClaim, false)
  })

  it('a refused claim stamp with an EARLIER transport time still protects (safe fallback)', () => {
    const doneAt = 1795290865225
    // refused token, but createdAt genuinely earlier than the done -> protection by fallback
    assert.equal(
      completedByOther(
        [claim('20:16Z', doneAt - 60000), done(String(doneAt), doneAt)],
        'bravo',
      ),
      null,
    )
  })

  it('a date-less DONE stamp is refused too, falling back to its transport time', () => {
    const claimAt = 1795290865225
    // done `at: 20:16Z` refused -> createdAt (later than my claim) orders it after -> protected
    assert.equal(
      completedByOther(
        [claim(String(claimAt), claimAt), done('20:16Z', claimAt + 60000)],
        'bravo',
      ),
      null,
    )
  })
})
