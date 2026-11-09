const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { CoordService } = require('../../src/coord')
const { Cli } = require('../../src/cli')

// #87: `review` signed the ISSUE comment and left the PR thread to a hand-run
// `gh pr comment`, which carries no author signal - every agent on this box pushes as
// the same account, so the verdict was a claim with no claimant. Measured on pi-agents
// PR #80 (merged `0b47a50`): a long APPROVE with no `agent-*` token anywhere in its four
// comments or its (empty) reviews array, while issue #79's own **REVIEW** line read
// `agent: agent-foxtrot`, i.e. the author. As recorded, the branch shipped with no
// self-identified non-author witness.
//
// The arms below pin the fix (both surfaces get the signed header) AND the two ways this
// change could have been silently wrong: a `try/catch` around a missing seam swallows the
// TypeError, which I measured at 457/457 green before adding the throw; and an optional
// write that reads as a clean success when it did not land.

const NOW = 1700000000000
const LABELLED = ['bug', 'status:claimed', 'status:in-review']
const asObjects = (names) => names.map((name) => ({ name }))

const world = ({ prFail = false, seam = true, agent = 'agent-bravo' } = {}) => {
  const issueWrites = []
  const prWrites = []
  const github = {
    repo: 'Sullux/pi-agents',
    issueKind: async () => ({ isPullRequest: false }),
    viewIssue: async () => ({
      number: 34,
      title: 'T',
      body: '## Files\nsrc/foo.js',
      labels: asObjects(LABELLED),
      comments: [],
    }),
    listIssues: async () => [],
    listLabels: async () => asObjects(LABELLED),
    commentIssue: async (number, body) => {
      issueWrites.push({ number, body })
    },
    editIssue: async () => '',
    closeIssue: async () => '',
  }
  if (seam) {
    github.commentPr = async (number, body) => {
      if (prFail) throw new Error('could not find issue #33')
      prWrites.push({ number, body })
    }
  }
  return {
    issueWrites,
    prWrites,
    coord: CoordService({ github, agent, human: 'Sullux', now: () => NOW }),
  }
}

// The shipped line is `... | at: <now> | pr: #<pr>` - `at` BEFORE `pr`, because the base
// string is built first and the pr clause is appended. Issue #87's box 1 quoted them in the
// other order; the code wins and this helper is the pin that says so.
const header = (agent, pr) =>
  `**REVIEW** | agent: agent-${agent} | at: ${NOW} | pr: #${pr}`

describe('#87: a review verdict is signed where it is read, not only on the issue', () => {
  it('with --pr, BOTH surfaces get the comment and the issue line is unchanged', async () => {
    const w = world()
    const res = await w.coord.review(34, {
      pr: 33,
      text: 'LGTM, probe table attached',
    })

    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(w.issueWrites.length, 1, 'the issue comment still lands')
    assert.equal(w.prWrites.length, 1, 'the PR thread gets the verdict too')

    const first = (body) => body.split('\n')[0]
    assert.equal(
      first(w.issueWrites[0].body),
      header('bravo', 33),
      'the issue-side protocol line keeps the exact pre-existing shape',
    )
    assert.equal(
      first(w.prWrites[0].body),
      header('bravo', 33),
      'the PR comment is the same protocol line, not a paraphrase',
    )
    assert.equal(w.prWrites[0].number, 33, 'posted to the PR, not the issue')
    assert.equal(
      w.prWrites[0].body.includes('LGTM, probe table attached'),
      true,
      'the verdict text travels with the signature',
    )
  })

  it('the PR thread carries an author token - the thing that was missing on #80', async () => {
    const w = world()
    await w.coord.review(34, { pr: 33, text: 'APPROVE' })
    const body = w.prWrites[0].body
    assert.match(
      body,
      /agent: agent-bravo/,
      `an unsigned verdict is unattributable on a shared account: ${body}`,
    )
    assert.equal(
      w.prWrites.length,
      1,
      'the arm is not vacuous: a comment really was staged',
    )
  })

  it('without --pr nothing touches a PR thread (back-compat)', async () => {
    const w = world()
    const res = await w.coord.review(34, { text: 'verdict, no pr' })
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(w.issueWrites.length, 1)
    assert.equal(w.prWrites.length, 0, 'no PR number, no PR write')
    assert.equal(res.prCommented, undefined)
    assert.equal(res.prCommentWarning, undefined)
    assert.equal(
      w.issueWrites[0].body.split('\n')[0],
      `**REVIEW** | agent: agent-bravo | at: ${NOW}`,
      'the no-pr header keeps its original form, with no `| pr:`',
    )
  })

  it('a PR write that fails is a WARNING and never undoes or blocks the issue record', async () => {
    const w = world({ prFail: true })
    const res = await w.coord.review(34, { pr: 33, text: 'verdict' })
    assert.equal(
      w.issueWrites.length,
      1,
      'the protocol record is written first and stays written',
    )
    assert.equal(res.ok, true, 'a failed second write is not a failed verb')
    assert.equal(res.prCommented, undefined)
    assert.match(
      String(res.prCommentWarning),
      /could not find issue #33/,
      `the reason must survive: ${JSON.stringify(res)}`,
    )
  })

  it('a client with no commentPr seam FAILS LOUDLY rather than reading green', async () => {
    // This is the arm that would not exist if I had left the catch alone: with only a
    // `try/catch`, a missing seam became `{ prCommentWarning: 'github.commentPr is not
    // a function' }`, ignored by every pre-existing assertion - measured 457/457 green
    // while no verdict reached any thread.
    const w = world({ seam: false })
    await assert.rejects(
      () => w.coord.review(34, { pr: 33, text: 'verdict' }),
      /needs github\.commentPr on the injected client \(#87\)/,
      'a programming error must not be reported as a runtime outcome',
    )
  })
})

describe('#87 CLI half: the operator hears which half landed', () => {
  const cliHarness = ({ prFail = false }) => {
    const out = []
    const err = []
    const cli = Cli({
      github: { repo: 'Sullux/pi-agents' },
      coordFactory: ({ agent }) =>
        CoordService({
          github: {
            issueKind: async () => ({ isPullRequest: false }),
            viewIssue: async () => ({
              number: 34,
              title: 'T',
              body: '## Files\nsrc/foo.js',
              labels: asObjects(LABELLED),
              comments: [{ body: `**CLAIM** | agent: ${agent} | at: ${NOW}` }],
            }),
            listIssues: async () => [],
            listLabels: async () => asObjects(LABELLED),
            commentIssue: async () => '',
            editIssue: async () => '',
            closeIssue: async () => '',
            commentPr: async () => {
              if (prFail) throw new Error('could not find issue #33')
              return ''
            },
          },
          agent,
          human: 'Sullux',
          now: () => NOW,
        }),
      provenance: { describe: () => '', note: () => '' },
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    })
    return {
      out,
      err,
      run: () => cli.run(['coord', 'review', '34', '--pr', '33', 'LGTM']),
    }
  }

  const caveat = (out) =>
    out.filter((l) => l.startsWith('  ! the issue comment is recorded'))

  it('success prints a dot-line attesting the PR write, before the headline', async () => {
    const h = cliHarness({ prFail: false })
    assert.equal(await h.run(), 0, `${h.err} | ${h.out}`)
    const dot = h.out.filter((l) =>
      l.startsWith('  · verdict also signed on PR #33'),
    )
    assert.equal(dot.length, 1, h.out.join(' | '))
    const atDot = h.out.findIndex((l) =>
      l.startsWith('  · verdict also signed'),
    )
    const atHead = h.out.findIndex((l) =>
      l.startsWith('Moved #34 to in-review'),
    )
    assert.ok(atHead >= 0, `headline missing: ${h.out.join(' | ')}`)
    assert.ok(
      atDot < atHead,
      '#44 ordering: the caveat about the second write precedes the attestation',
    )
    assert.deepEqual(h.err, [], 'a dot-line is not an error')
  })

  it('a failed PR write prints the caveat AND still keeps the issue record true', async () => {
    const h = cliHarness({ prFail: true })
    assert.equal(await h.run(), 0, `${h.err} | ${h.out}`)
    assert.equal(caveat(h.out).length, 1, h.out.join(' | '))
    assert.match(
      caveat(h.out)[0],
      /could not find issue #33/,
      'the operator is told WHY, not merely that',
    )
    assert.equal(
      h.out.some((l) => l.startsWith('  · verdict also signed')),
      false,
      'the success dot-line must not print when nothing was signed',
    )
  })
})
