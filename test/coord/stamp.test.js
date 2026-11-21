const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const {
  stampOfMarker,
  MARKER_STAMP_RE,
  parseStamp,
} = require('../../src/coord/stamp')
const { malformedStamps } = require('../../src/coord/owner')
const { formatSync } = require('../../src/coord/formatters')

// #167: the stamp field is the arbitration record. These arms pin the ONE renderer, the
// full-token parser, and the loud refusal - the digit-prefix trap is the headline arm.
describe('#167 stamp formatter and parser', () => {
  it('stampOfMarker renders epoch milliseconds from the injected clock', () => {
    assert.equal(
      stampOfMarker(() => 1795290865225),
      '1795290865225',
    )
    assert.equal(
      stampOfMarker(() => 1),
      '1',
    )
  })

  it('MARKER_STAMP_RE captures the WHOLE token, not a digit prefix', () => {
    assert.equal('| at: 20:16Z'.match(MARKER_STAMP_RE)[1], '20:16Z')
    assert.equal(
      '| at: 1795290865225'.match(MARKER_STAMP_RE)[1],
      '1795290865225',
    )
    assert.equal(
      '| at: 2026-10-26T15:58:04Z | pr: #4'.match(MARKER_STAMP_RE)[1],
      '2026-10-26T15:58:04Z',
    )
  })

  it('parseStamp orders epoch-ms and full ISO 8601 to the same millisecond axis', () => {
    assert.deepEqual(parseStamp('1795290865225'), {
      ok: true,
      ms: 1795290865225,
    })
    const iso = parseStamp('2026-10-26T15:58:04Z')
    assert.equal(iso.ok, true)
    assert.equal(iso.ms, Date.parse('2026-10-26T15:58:04Z'))
    // cross-format ordering is meaningful: the Nov epoch sample is later than the Oct ISO instant
    assert.ok(
      parseStamp('1795290865225').ms > parseStamp('2026-10-26T15:58:04Z').ms,
    )
  })

  it('THE TRAP: a date-less HH:MMZ token is REFUSED, never coerced to epoch 20', () => {
    // the old /\|\s*at:\s*(\d+)/ read this as Number('20') === 20 and let it win comparisons
    assert.deepEqual(parseStamp('20:16Z'), { ok: false, token: '20:16Z' })
    assert.deepEqual(parseStamp('19:56Z'), { ok: false, token: '19:56Z' })
  })

  it('parseStamp refuses garbage and invalid dates, carrying the raw token', () => {
    assert.deepEqual(parseStamp('soon'), { ok: false, token: 'soon' })
    assert.deepEqual(parseStamp(''), { ok: false, token: '' })
    assert.deepEqual(parseStamp('2026-13-40T99:99:99Z'), {
      ok: false,
      token: '2026-13-40T99:99:99Z',
    })
    // a date-less ISO time is not orderable across midnight
    assert.deepEqual(parseStamp('15:58:04Z'), { ok: false, token: '15:58:04Z' })
  })
})

describe('#167 malformedStamps names refused tokens loudly', () => {
  const claim = (at) => ({
    body: `**CLAIM** | agent: agent-bravo | at: ${at}\n\nplan: x`,
  })

  it('flags a date-less stamp on a CLAIM with its raw token and agent', () => {
    const found = malformedStamps([claim('20:16Z')])
    assert.deepEqual(found, [
      { marker: 'CLAIM', agent: 'bravo', token: '20:16Z' },
    ])
  })

  it('is empty when every stamp parses (epoch and ISO both)', () => {
    assert.deepEqual(
      malformedStamps([claim('1795290865225'), claim('2026-10-26T15:58:04Z')]),
      [],
    )
  })

  it('ignores lines with no at: field and non-fold markers (REVIEW/SYNC)', () => {
    assert.deepEqual(
      malformedStamps([{ body: '**CLAIM** | agent: agent-bravo\n\nplan: x' }]),
      [],
    )
    assert.deepEqual(
      malformedStamps([
        { body: '**REVIEW** | agent: agent-bravo | at: 20:16Z' },
      ]),
      [],
    )
    assert.deepEqual(
      malformedStamps([{ body: '**SYNC** | agent: agent-bravo | at: 20:16Z' }]),
      [],
    )
  })

  it('inspects DONE and HANDOFF too, and keeps the unattributed case nameable', () => {
    const found = malformedStamps([
      { body: '**DONE** | at: 20:16Z' },
      { body: '**HANDOFF** | agent: agent-x | to: @bravo | at: bogus' },
    ])
    assert.deepEqual(found, [
      { marker: 'DONE', agent: '', token: '20:16Z' },
      { marker: 'HANDOFF', agent: 'x', token: 'bogus' },
    ])
  })
})

describe('#167 sync surfaces refused stamps loudly, naming issue and raw token', () => {
  const base = {
    issues: [],
    currentAgent: 'bravo',
    repo: 'test/repo',
    hub: null,
    now: 1,
  }

  it('renders a named warning carrying the issue number and the raw token', () => {
    const text = formatSync({
      ...base,
      stampWarnings: [
        { issue: 167, marker: 'CLAIM', agent: 'bravo', token: '20:16Z' },
      ],
    })
    assert.match(text, /malformed at: stamps/)
    assert.match(
      text,
      /#167 CLAIM \(bravo\): raw token `20:16Z` is unparseable - NOT used for ordering/,
    )
  })

  it('renders no warning section when every stamp resolved', () => {
    assert.doesNotMatch(
      formatSync({ ...base, stampWarnings: [] }),
      /malformed at: stamps/,
    )
  })
})
