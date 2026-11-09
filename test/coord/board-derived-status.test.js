const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { protocolStatus, ownerOf } = require('../../src/coord/owner')
const { formatBoard } = require('../../src/coord/formatters')
const { checkScopeCollision } = require('../../src/coord/scope')

// #66: in a repo that carries no `status:*` labels, `statusOf`'s `|| 'unclaimed'` fallback was the
// entire answer for every row, so the board printed `#53 unclaimed ... foxtrot` - a row that
// contradicts itself - while `ownerOf`, reading the CLAIM timeline, was right. These pins hold the
// derived cell, its precedence rules, and the two footers that make a derived cell legible.

const CLAIM =
  '**CLAIM** | agent: agent-alpha | human: @Sullux | at: 2026-10-28T04:00:00Z'
const RELEASE = '**RELEASE** | agent: agent-alpha | at: 2026-10-28T05:00:00Z'
const HANDOFF =
  '**HANDOFF** | agent: agent-alpha | to: agent-bravo | at: 2026-10-28T05:30:00Z'
const REVIEW =
  '**REVIEW** | agent: agent-bravo | at: 2026-10-28T06:00:00Z | pr: #9'
const doneBy = (agent) =>
  `**DONE** | agent: ${agent} | pr: #9 | at: 2026-10-28T07:00:00Z`

const mk = (labels, ...bodies) => ({
  number: 42,
  title: 'Board status probe',
  body: '## Goal\nx\n\n## Files\nsrc/x.js',
  labels,
  comments: bodies.map((body) => ({ body })),
})

const rowOf = (out) =>
  out.split('\n').find((line) => line.startsWith('#42')) || ''

// The STATUS column is `pad(x, 12)` starting at index 7 after `pad('#42', 6)` + one space. Read the
// cell, never the line: `unclaimed` CONTAINS `claimed`, so a substring assert on the word can only
// ever be satisfied by the state it means to rule out (measured while writing this file - my own
// first version of the ratchet arm below passed a correct row and failed a correct one).
const cellOf = (out) => rowOf(out).slice(7, 19).trim()

describe('board STATUS: derived from the timeline when no status label exists (#66)', () => {
  it('a label-less issue holding a CLAIM reads claimed, and agrees with its OWNER cell', () => {
    const out = formatBoard([mk([], CLAIM)], 'delta', 'Sullux/example')
    const row = rowOf(out)

    assert.ok(row.includes('claimed'), `expected a claimed cell: ${row}`)
    assert.ok(
      !row.includes('unclaimed'),
      `the row must not call a held issue free: ${row}`,
    )
    assert.ok(row.includes('alpha'), `OWNER still names the holder: ${row}`)
    // the row is the claim; the footer is its provenance. Both must be present or a reader cannot
    // tell a derived cell from a human-set one.
    assert.ok(
      out.includes('derived from their protocol timeline'),
      `provenance footer missing: ${out}`,
    )
    assert.ok(
      out.includes('#42'),
      'non-vacuity: the derived row is the one announced',
    )
    assert.ok(
      out.includes('Sullux/example'),
      'the footer names the repo it looked at, not a bare count',
    )
  })

  it('the label always wins, so a repo that labels its issues cannot shift at all', () => {
    const labelled = mk(['status:in-progress', 'p2'], CLAIM)
    const out = formatBoard([labelled], 'delta', 'Sullux/example')

    assert.equal(
      cellOf(out),
      'in-progress',
      `a present label must not be overridden by the timeline: ${rowOf(out)}`,
    )
    assert.ok(
      !out.includes('derived from their protocol timeline'),
      'a labelled board must stay footer-free, or every pitcairn run gets noise',
    )
    assert.ok(
      !out.includes('label and the CLAIM comments disagree'),
      'precedence is silent when the label answers first',
    )
  })

  it('a RELEASE that cleared the holder reads unclaimed again - derivation is not a ratchet', () => {
    const out = formatBoard([mk([], CLAIM, RELEASE)], 'delta', 'Sullux/example')

    assert.equal(
      cellOf(out),
      'unclaimed',
      `a released issue must free itself: ${rowOf(out)}`,
    )
    assert.equal(
      rowOf(out).slice(40, 67).trim(),
      '-',
      'and the OWNER column must clear with it, or the two disagree the other way',
    )
    assert.equal(ownerOf(mk([], CLAIM, RELEASE)), '', "the fold's own witness")
  })

  it('a trailing REVIEW reads in-review, the state the review verb sets by label', () => {
    const out = formatBoard([mk([], CLAIM, REVIEW)], 'delta', 'Sullux/example')

    assert.ok(
      rowOf(out).includes('in-review'),
      `expected in-review: ${rowOf(out)}`,
    )
  })

  it('a bystander DONE keeps BOTH columns claimed-and-held, which last-marker-wins would break', () => {
    // This is the pin that separates a fold from a peek: `applyMarker` keeps alpha as holder when
    // bravo closes over it, so a status read off the LAST marker would print `unclaimed` beside
    // `OWNER alpha` - a new instance of the contradiction #66 exists to kill.
    const issue = mk([], CLAIM, doneBy('agent-bravo'))
    const out = formatBoard([issue], 'delta', 'Sullux/example')
    const row = rowOf(out)

    assert.equal(
      ownerOf(issue),
      'alpha',
      'the holder rule this arm inherits from #12',
    )
    assert.ok(row.includes('claimed'), `expected claimed: ${row}`)
    assert.ok(row.includes('alpha'), `expected the holder in OWNER: ${row}`)
    assert.ok(
      !row.includes('unclaimed'),
      `the two columns must never disagree: ${row}`,
    )
  })

  it('an unreadable CLAIM line reads claimed, not free (#49 across the status surface)', () => {
    const issue = mk([], '**CLAIM** by someone')

    assert.equal(ownerOf(issue), '', 'the holder is genuinely unreadable here')
    assert.equal(
      protocolStatus(issue),
      'claimed',
      'unreadable is not unclaimed',
    )

    const row = rowOf(formatBoard([issue], 'delta', 'Sullux/example'))
    assert.ok(row.includes('claimed'), `expected claimed: ${row}`)
    assert.ok(
      row.includes('-'),
      'OWNER may still be a dash - the state is not the owner',
    )
  })

  it('prose that quotes **CLAIM** mid-line creates no status, and no footer', () => {
    const issue = mk([], 'Neither had a **CLAIM** comment when I checked it')

    assert.equal(
      protocolStatus(issue),
      '',
      'a mid-line mention is not a marker',
    )
    const out = formatBoard([issue], 'delta', 'Sullux/example')
    assert.ok(
      rowOf(out).includes('unclaimed'),
      `expected the true fallback: ${rowOf(out)}`,
    )
    assert.ok(
      !out.includes('derived from their protocol timeline'),
      'a row with no evidence must not be announced as derived',
    )
  })

  it('a label that disagrees with the timeline is printed AND named, never silently contradicted', () => {
    // #46/#44 shape: the CLAIM comment landed, the label add failed with 'status:claimed' not
    // found, so the board would read `unclaimed` over a held issue and stay mute about it.
    const issue = mk(['status:unclaimed', 'p2'], CLAIM)
    const out = formatBoard([issue], 'delta', 'Sullux/example')

    assert.equal(
      cellOf(out),
      'unclaimed',
      'the label keeps precedence - callers read it, we do not rewrite it here',
    )
    assert.ok(
      out.includes("#42 label='unclaimed' timeline='claimed'"),
      `the disagreement must be named with both values: ${out}`,
    )
  })

  it('the reversal also fires the other way, which is the shape #44 actually shipped', () => {
    // label says held, timeline says free: a RELEASE landed while the label strip failed, or the
    // transition line was written from the wrong label set. Reading only "label says free" would
    // leave a stale claimed label pointing at an issue nobody holds - a phantom collision.
    const out = formatBoard([mk(['status:claimed'], RELEASE)], 'delta', 'R')

    assert.equal(cellOf(out), 'claimed', 'the label still wins the cell')
    assert.ok(
      out.includes("#42 label='claimed' timeline='unclaimed'"),
      `and the reversal is named: ${out}`,
    )
  })

  it('an in-progress label plus a CLAIM is NOT a contradiction - the coarse comparison is the guard', () => {
    // Without coarsening, every `status:in-progress` issue with a CLAIM (i.e. every normally
    // claimed issue in pitcairn) would print a disagreement footer, and the footer would stop
    // being a signal. This arm is the one that fails if the comparison goes back to raw strings.
    const out = formatBoard([mk(['status:in-progress'], CLAIM)], 'delta', 'R')

    assert.ok(!/disagree/.test(out), `expected a silent board: ${out}`)
  })

  it('the scope gate is untouched: a label-less held issue still fences a second claimant', () => {
    // The display fix must not become a gate change. `claim 53` refused correctly at the tip this
    // issue was filed against, and that refusal is the reason the defect is p2 and not p1.
    const held = mk([], CLAIM)
    const res = checkScopeCollision(['src/x.js'], [held], 'bravo', {
      number: 99,
      body: '## Files\nsrc/x.js',
      labels: ['status:unclaimed'],
    })

    assert.equal(res.hasCollision, true, JSON.stringify(res))
    assert.equal(
      res.collidingAgent,
      'alpha',
      'the fence names the holder it found',
    )
  })

  it('protocolStatus returns empty only for an issue with no protocol line at all', () => {
    assert.equal(protocolStatus(mk([], 'plain discussion')), '')
    assert.equal(protocolStatus(mk([])), '')
    assert.equal(protocolStatus({ comments: [] }), '')
    assert.equal(
      protocolStatus({}),
      '',
      'a label-less, comment-less issue is evidence-free',
    )
  })
})
