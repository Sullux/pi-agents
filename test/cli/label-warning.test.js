const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Cli } = require('../../src/cli')
const { CoordService } = require('../../src/coord')

// pi-agents#34, CLI half. The service now returns `{ ok: true, labelWarning }` where it used to
// throw, which is only an improvement if the operator HEARS about the half-done state: a silent
// `Claimed #34` is a lie of a different shape, because every agent that reads the board afterwards
// sees an issue that never moved. These arms drive the real Cli over the real CoordService with a
// mock github whose `editIssue` rejects with the measured gh sentence, because the defect was the
// wiring - the service already had a `labelWarning` in no arm at the broken tip, and the CLI read
// nothing but `res.ok` for all four mutating verbs.
//
// Measured at the broken tip (pi-agents a4d35a7, live, not simulated):
//   page coord claim 34  -> exit 1, stderr `'status:unclaimed' not found`, and the **CLAIM**
//                            comment 6476813382 HAD already landed
//   page coord review 34 -> exit 1 for the same reason after **REVIEW** 6476817555 landed
const GH_ERROR =
  "failed to update https://github.com/Sullux/pi-agents/issues/34: 'status:unclaimed' not found\nfailed to update 1 issue"

const harness = ({ sub, extra = [], fail = true, labels } = {}) => {
  const out = []
  const err = []
  const issue = {
    number: 34,
    body: '## Files\nsrc/foo.js\n\n## Goal\nTest',
    labels: labels || [{ name: 'status:unclaimed' }],
    // #28: done refuses without a live self-claim, and the CLAIM below is built from the agent
    // the CLI itself resolves, so the fixture cannot drift per machine
    comments: [],
  }
  const cli = Cli({
    github: { repo: 'Sullux/pi-agents' },
    coordFactory: ({ agent }) =>
      CoordService({
        github: {
          viewIssue: async () => ({
            ...issue,
            comments: [
              { body: `**CLAIM** | agent: ${agent} | at: 1700000000000` },
            ],
          }),
          listIssues: async () => [issue],
          commentIssue: async () => {},
          editIssue: async () => {
            if (fail) throw new Error(GH_ERROR)
          },
          closeIssue: async () => {},
        },
        agent,
        human: 'Sullux',
        now: () => 1700000000000,
      }),
    provenance: { describe: () => '', note: () => '' },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  })
  const run = () => cli.run(['coord', sub, '34', ...extra])
  return { out, err, run }
}

const warningLines = (out) =>
  out.filter((l) => l.startsWith('  ! labels unchanged:'))

// #44: the transition attestation. `review` is the verb whose ONLY board move IS the label, so when
// the label write fails it must not print a line that reads as a transition - and the caveat has to
// land BEFORE whatever is printed, or an agent greps the first line and stops reading.
const REVIEW_FALSE_LINE = 'Moved #34 to in-review @Sullux/pi-agents'
const REVIEW_HONEST_LINE_PREFIX =
  'REVIEW comment recorded on #34 @Sullux/pi-agents'

describe('page coord reports a failed label edit as a warning, not a failure (#34)', () => {
  const cases = [
    ['claim', 'Claimed #34', []],
    ['release', 'Released #34', []],
    // #44: the label write failed, so `Moved #34 to in-review` was attesting a transition that did
    // not happen. This is the one verb whose success line changes on the failure path, and the
    // byte-identity of the SUCCESS path is pinned separately below rather than weakened here.
    ['review', REVIEW_HONEST_LINE_PREFIX, ['verdict text']],
    ['done', 'Marked #34 done', ['attestation text']],
  ]

  for (const [sub, successPrefix, extra] of cases) {
    it(`${sub} exits 0, keeps its success line, and names gh's sentence`, async () => {
      const h = harness({ sub, extra })
      assert.equal(
        await h.run(),
        0,
        `${h.err.join(' | ')}\n${h.out.join(' | ')}`,
      )
      assert.ok(
        h.out.some((l) => l.startsWith(successPrefix)),
        `the pinned success line must not be displaced: ${h.out.join(' | ')}`,
      )
      assert.deepEqual(
        h.err,
        [],
        'a recorded action must not also print an Error',
      )
      const warn = warningLines(h.out)
      assert.equal(warn.length, 1, h.out.join(' | '))
      assert.ok(
        !warn[0].includes('\n'),
        `the whole warning must sit on the one decorated line: ${warn[0]}`,
      )
      assert.ok(
        warn[0].includes("'status:unclaimed' not found"),
        `the warning carries gh's own words: ${warn[0]}`,
      )
      assert.ok(
        warn[0].includes('the protocol comment on this issue is the record'),
        `and tells the operator what still holds: ${warn[0]}`,
      )
    })
  }

  // #44 box 1: BOTH printed lines, and their order. The caveat is line 0 because the defect was an
  // operator reading `Moved #28 to in-review` off the first line of a run that never moved the board.
  it('review prints the label caveat BEFORE the attestation that cannot be read as a board move', async () => {
    const h = harness({ sub: 'review', extra: ['verdict text'] })
    assert.equal(await h.run(), 0, h.out.join(' | '))
    assert.ok(h.out[0].startsWith('  ! labels unchanged:'), h.out[0])
    assert.equal(
      h.out.filter((l) => l.startsWith(REVIEW_HONEST_LINE_PREFIX)).length,
      1,
      `the honest line is the attestation on this path: ${h.out.join(' | ')}`,
    )
    assert.equal(
      h.out.filter((l) => l === REVIEW_FALSE_LINE).length,
      0,
      `a grep of ^Moved must find nothing when the label did not move: ${h.out.join(' | ')}`,
    )
  })

  // #44 box 2, and the asymmetry it documents: `done` attests the CLOSE (a failed close throws, so
  // ok:true means the issue is closed), so its byte-pinned line stays and only the ORDER changes.
  it('done keeps its byte-pinned close line but reports the caveat first', async () => {
    const h = harness({
      sub: 'done',
      extra: ['attestation text'],
      labels: [{ name: 'status:unclaimed' }],
    })
    assert.equal(await h.run(), 0, h.out.join(' | '))
    assert.ok(h.out[0].startsWith('  ! labels unchanged:'), h.out[0])
    assert.equal(
      h.out.filter((l) => l === 'Marked #34 done @Sullux/pi-agents').length,
      1,
      h.out.join(' | '),
    )
  })

  // claim and release name the PROTOCOL COMMENT, which landed regardless of the label (Rule C), so
  // their order is deliberately unchanged. Pinned so a future "make them all uniform" edit has to
  // decide, not drift.
  it('claim and release still attest the comment first - the asymmetry is the point (#44)', async () => {
    for (const [sub, prefix, extra] of [
      ['claim', 'Claimed #34', []],
      ['release', 'Released #34', []],
    ]) {
      const h = harness({ sub, extra })
      assert.equal(await h.run(), 0, h.out.join(' | '))
      assert.ok(
        h.out[0].startsWith(prefix),
        `${sub} reordered a line that names the comment, not the label: ${h.out.join(' | ')}`,
      )
      assert.equal(warningLines(h.out).length, 1, h.out.join(' | '))
    }
  })

  // #44 box 3: the exact-line pin is SUPPLEMENTED, not weakened - the success path still prints
  // `Moved #N to in-review @target` byte-for-byte and never the honest-line variant.
  it('the success path still prints Moved #N to in-review byte-for-byte (#44 box 3)', async () => {
    const h = harness({ sub: 'review', extra: ['verdict text'], fail: false })
    assert.equal(await h.run(), 0, h.out.join(' | '))
    assert.deepEqual(
      h.out,
      [REVIEW_FALSE_LINE],
      `one line, exact text, no caveat, no substitute: ${h.out.join(' | ')}`,
    )
  })

  // Non-vacuity for the whole describe: a healthy repo must print NO warning, or the four arms
  // above would pass on an unconditional decoration.
  it('prints no warning when the label edit succeeds', async () => {
    for (const [sub, , extra] of cases) {
      const h = harness({ sub, extra, fail: false })
      assert.equal(await h.run(), 0)
      assert.deepEqual(
        warningLines(h.out),
        [],
        `${sub} warned on a successful edit: ${h.out.join(' | ')}`,
      )
    }
  })

  // The guard against over-broadening: making the LABEL step best-effort must not turn a real
  // service refusal into a success. Scope refusal is the nearest one, and it fires before any
  // write, so an `ok: false` here still costs exit 1 and an Error line.
  it('still exits 1 on a genuine refusal - ok:false was not blanket-demoted', async () => {
    const h = harness({ sub: 'claim' })
    const cli = Cli({
      github: { repo: 'Sullux/pi-agents' },
      coordFactory: ({ agent }) =>
        CoordService({
          github: {
            viewIssue: async () => ({
              number: 34,
              body: '## Goal\nno Files section at all',
              labels: [],
              comments: [],
            }),
            listIssues: async () => [],
            commentIssue: async () => {},
            editIssue: async () => {},
          },
          agent,
          human: 'Sullux',
          now: () => 1700000000000,
        }),
      provenance: { describe: () => '', note: () => '' },
      stdout: (line) => h.out.push(line),
      stderr: (line) => h.err.push(line),
    })
    assert.equal(await cli.run(['coord', 'claim', '34']), 1)
    assert.match(h.err.join(' '), /declares no Files scope/)
    assert.deepEqual(warningLines(h.out), [])
  })
})
