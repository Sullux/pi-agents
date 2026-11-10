const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { CoordService } = require('../../src/coord')

// #94: `done` used to close over an unticked Done-when list without looking at it, so the board's
// attestation column was decoration and six issues proved it (pitcairn #1207/#1201/#1193, pi
// #90/#81/#76 - all closed with zero boxes ticked). These arms pin the three paths the guard offers:
// refuse, close-with-evidence, close-with-override - and the refusal arms assert ZERO side effects,
// because #28 already established that a refusal which has commented is not a refusal.
const build = (body, { agent = 'delta' } = {}) => {
  const issue = {
    number: 50,
    body,
    labels: [{ name: 'status:claimed' }],
    comments: [
      { body: `**CLAIM** | agent: agent-${agent} | at: 1700000000000` },
    ],
  }
  const commented = []
  const edited = []
  const closed = []
  const coord = CoordService({
    github: {
      issueKind: async () => ({ isPullRequest: false }),
      viewIssue: async () => issue,
      listIssues: async () => [issue],
      commentIssue: async (num, text) => {
        commented.push({ num, text })
      },
      editIssue: async (num, edits) => {
        edited.push({ num, edits })
      },
      closeIssue: async (num) => {
        closed.push(num)
      },
    },
    agent,
    human: 'Sullux',
    now: () => 1700000000000,
  })
  return { coord, commented, edited, closed }
}

const UNATTENDED =
  '## Goal\ng\n\n## Done when\n- [x] measured\n- [ ] not measured\n- [ ] also not\n\n## Files\nsrc/foo.js\n'
const ALL_TICKED = '## Done when\n- [x] one\n- [x] two\n'
const NUMBERED_ONLY = '## Done when\n1. first\n2. second\n'
const NO_SECTION = '## Goal\ng\n\n## Files\nsrc/foo.js\n'

describe('done (close requires an attestation, #94)', () => {
  it('refuses to close while boxes stay unticked and names the exact counts', async () => {
    const { coord, commented, edited, closed } = build(UNATTENDED)
    const res = await coord.done(50, {})
    assert.equal(res.ok, false, 'an unattested close must not report success')
    assert.match(
      res.error,
      /2 of 3 Done-when boxes unticked/,
      'the fired-proof: the counts are in the sentence',
    )
    assert.match(
      res.error,
      /--force/,
      'and the escape is stated, not left to be discovered',
    )
    assert.deepEqual(
      [commented, edited, closed],
      [[], [], []],
      'a refusal writes NOTHING',
    )
  })

  it('closes when the caller supplies measurements as the message, and marks the line', async () => {
    const { coord, commented, closed } = build(UNATTENDED)
    const res = await coord.done(50, {
      text: 'measured at ad03d2c: 487/487/0, all three boxes verified',
    })
    assert.equal(res.ok, true)
    assert.equal(closed.length, 1)
    assert.match(commented[0].text, /^\*\*DONE\*\*/)
    assert.match(
      commented[0].text,
      /unattested: 2\/3/,
      'the close says it landed over unticked boxes',
    )
    assert.match(
      commented[0].text,
      /evidence in message/,
      'and says which path was taken',
    )
    assert.equal(
      res.unattested,
      2,
      'the count is in the return value too, not only in prose',
    )
  })

  it('lets --force through with no message and records the override as the worse variant', async () => {
    const { coord, commented } = build(UNATTENDED)
    const res = await coord.done(50, { force: true })
    assert.equal(res.ok, true)
    assert.match(
      commented[0].text,
      /unattested: 2\/3 \| forced over unticked boxes/,
    )
  })

  // The conditional's other half. Without this arm the marker would be decoration: a note printed on
  // every close tells an auditor nothing, and a later refactor that makes it unconditional would pass.
  it('writes no unattested marker when the section is fully ticked', async () => {
    const { coord, commented } = build(ALL_TICKED)
    const res = await coord.done(50, {})
    assert.equal(res.ok, true, 'a clean close needs no message at all')
    assert.doesNotMatch(commented[0].text, /unattested:/)
    assert.equal(res.unattested, 0)
  })

  it('does not block a numbered Done-when, which has no tick mechanism to satisfy', async () => {
    const { coord, closed } = build(NUMBERED_ONLY)
    const res = await coord.done(50, {})
    assert.equal(
      res.ok,
      true,
      'pitcairn #1203 and pi #87 are written this way and close legitimately',
    )
    assert.equal(closed.length, 1)
  })

  it('does not block an issue with no Done-when section at all', async () => {
    const { coord, closed } = build(NO_SECTION)
    const res = await coord.done(50, {})
    assert.equal(res.ok, true)
    assert.equal(closed.length, 1)
  })

  it('is not fooled by a code-fenced quotation of a box line inside the section', async () => {
    const { coord, closed } = build(
      '## Done when\n```md\n- [ ] this line is a quoted example\n```\n',
    )
    const res = await coord.done(50, {})
    assert.equal(res.ok, true, 'documentation is not an unmet requirement')
    assert.equal(closed.length, 1)
    assert.equal(res.unattested, 0)
  })

  it('leaves #28 ownership refusal in front of the attestation check, unchanged', async () => {
    // ordering is part of the contract being pinned: #28 established that the ownership read happens
    // above the first write, and a new guard inserted below it must not become the thing that answers
    // first - otherwise the close path depends on which of two refusals a caller happens to trigger.
    const { commented, closed } = build(UNATTENDED, { agent: 'delta' })
    const stranger = CoordService({
      github: {
        issueKind: async () => ({ isPullRequest: false }),
        viewIssue: async () => ({
          number: 50,
          body: UNATTENDED,
          labels: [],
          comments: [
            { body: '**CLAIM** | agent: agent-delta | at: 1700000000000' },
          ],
        }),
        listIssues: async () => [],
        commentIssue: async (num, text) => commented.push({ num, text }),
        editIssue: async () => {},
        closeIssue: async (num) => closed.push(num),
      },
      agent: 'echo',
      human: 'Sullux',
      now: () => 1700000000000,
    })
    const res = await stranger.done(50, {})
    assert.equal(res.ok, false)
    assert.match(
      res.error,
      /held by agent-delta/,
      'the refusal is the ownership one, not the tick one',
    )
    assert.equal(closed.length, 0)
  })
})
