const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Cli } = require('../../src/cli')
const { CoordService } = require('../../src/coord')

// #79, CLI half. The service now returns `{ ok: true, labelNotice }` when a repo has no `status:`
// labels at all, and this file pins what the OPERATOR hears: the accurate fact rather than a quoted
// API refusal - and, the sharper half, that `review` must not claim a transition it never made.
// #44's rule is that review's ONLY board move is the label; a skipped write is not a moved board,
// it just fails for a reason that never reaches gh. Driving the real Cli over the real CoordService
// is the only way to see that, because the two fields diverge in the wiring, not in the service.
const GH_DEFAULTS = [
  'bug',
  'enhancement',
  'documentation',
  'invalid',
  'question',
  'wontfix',
]
const WITH_STATUS = ['bug', 'status:claimed', 'status:in-review']
const asObjects = (names) => names.map((name) => ({ name }))

const REVIEW_FALSE_LINE = 'Moved #34 to in-review @Sullux/pi-agents'
const REVIEW_HONEST_LINE_PREFIX =
  'REVIEW comment recorded on #34 @Sullux/pi-agents'
const NOTICE_PREFIX = '  · this repo carries no status: labels'

const harness = ({
  sub,
  extra = [],
  taxonomy = asObjects(GH_DEFAULTS),
  seam = true,
  fail = false,
} = {}) => {
  const out = []
  const err = []
  const calls = { edit: 0 }
  const issue = {
    number: 34,
    title: 'T',
    body: '## Files\nsrc/foo.js\n\n## Goal\nT',
    labels: asObjects(WITH_STATUS),
    comments: [],
  }
  const cli = Cli({
    github: { repo: 'Sullux/pi-agents' },
    coordFactory: ({ agent }) =>
      CoordService({
        github: {
          issueKind: async () => ({ isPullRequest: false }),
          viewIssue: async () => ({
            ...issue,
            comments: [
              { body: `**CLAIM** | agent: ${agent} | at: 1700000000000` },
            ],
          }),
          listIssues: async () => [issue],
          commentIssue: async () => {},
          closeIssue: async () => {},
          editIssue: async () => {
            calls.edit += 1
            if (fail) {
              throw new Error(
                "failed to update https://github.com/Sullux/pi-agents/issues/34: 'status:claimed' not found",
              )
            }
          },
          ...(seam ? { listLabels: async () => taxonomy } : {}),
        },
        agent,
        human: 'Sullux',
        now: () => 1700000000000,
      }),
    provenance: { describe: () => '', note: () => '' },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  })
  return {
    out,
    err,
    calls,
    run: () => cli.run(['coord', sub, '34', ...extra]),
  }
}

const noticeLines = (out) => out.filter((l) => l.startsWith(NOTICE_PREFIX))
const warningLines = (out) =>
  out.filter((l) => l.startsWith('  ! labels unchanged:'))

describe('#79: the CLI reports a skipped write as a fact, not an error', () => {
  for (const [sub, successPrefix, extra] of [
    ['claim', 'Claimed #34', []],
    ['release', 'Released #34', []],
    ['done', 'Marked #34 done', ['attestation text']],
  ]) {
    it(`${sub}: prints the notice, no warning, and issues zero label calls`, async () => {
      const h = harness({ sub, extra })
      assert.equal(
        await h.run(),
        0,
        `${h.err.join(' | ')}\n${h.out.join(' | ')}`,
      )
      assert.ok(
        h.out.some((l) => l.startsWith(successPrefix)),
        `the #34 success line must survive: ${h.out.join(' | ')}`,
      )
      assert.equal(h.calls.edit, 0, 'the doomed call is never made')
      assert.equal(noticeLines(h.out).length, 1, h.out.join(' | '))
      assert.equal(
        warningLines(h.out).length,
        0,
        'nothing failed, so nothing may be decorated as a failure',
      )
      assert.deepEqual(h.err, [], 'a notice is not an error')
    })
  }

  it('review in a label-less repo must NOT attest a transition it did not make (#44 by another route)', async () => {
    const h = harness({ sub: 'review', extra: ['verdict text'] })
    assert.equal(await h.run(), 0, h.out.join(' | '))
    assert.ok(
      !h.out.includes(REVIEW_FALSE_LINE),
      `RED without the #79 branch in reviewLine: the label never moved, so "in-review" is false: ${h.out.join(
        ' | ',
      )}`,
    )
    assert.ok(
      h.out.some((l) => l.startsWith(REVIEW_HONEST_LINE_PREFIX)),
      h.out.join(' | '),
    )
    assert.equal(noticeLines(h.out).length, 1, h.out.join(' | '))
  })

  it('a repo that HAS the taxonomy still gets its write and gh quoted verbatim (#34 unsoftened)', async () => {
    const h = harness({
      sub: 'claim',
      taxonomy: asObjects(WITH_STATUS),
      fail: true,
    })
    assert.equal(await h.run(), 0, h.out.join(' | '))
    assert.equal(
      h.calls.edit,
      1,
      'the write is real here - skipping it would break the board',
    )
    assert.equal(noticeLines(h.out).length, 0)
    const warn = warningLines(h.out)
    assert.equal(warn.length, 1, h.out.join(' | '))
    assert.ok(
      warn[0].includes("'status:claimed' not found"),
      `gh's own sentence must still be the evidence: ${warn[0]}`,
    )
  })

  it('a double with no listLabels seam behaves exactly as before (back-compat, no phantom notice)', async () => {
    const h = harness({ sub: 'claim', seam: false, fail: true })
    assert.equal(await h.run(), 0, h.out.join(' | '))
    assert.equal(h.calls.edit, 1)
    assert.equal(noticeLines(h.out).length, 0)
    assert.equal(warningLines(h.out).length, 1, 'the old path is untouched')
  })

  it('the notice sits after the success line, so a first-line grep cannot read it as the verdict', async () => {
    const h = harness({ sub: 'claim' })
    await h.run()
    const success = h.out.findIndex((l) => l.startsWith('Claimed #34'))
    const notice = h.out.findIndex((l) => l.startsWith(NOTICE_PREFIX))
    assert.ok(success >= 0 && notice > success, h.out.join(' | '))
  })
})
