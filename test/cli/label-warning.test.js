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

describe('page coord reports a failed label edit as a warning, not a failure (#34)', () => {
  const cases = [
    ['claim', 'Claimed #34', []],
    ['release', 'Released #34', []],
    ['review', 'Moved #34 to in-review', ['verdict text']],
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
