// pi-agents#154: `coord release` was the one mutating verb that ignored a positional reason, so
// the call shape the other verbs train you to use (`coord status 34 "text"`) printed
// `**RELEASE** | agent: ... | reason: unspecified`, exited 0, and POSTED - a protocol line that
// actively misrepresents a explained release as an unexplained one. These arms pin the four call
// shapes (positional, flag, both, neither), the no-value `--reason` quirk that used to post the
// literal string `true`, the library-only reachability of the `unspecified` fallback, and - the
// part that stops recurrence - that the help block is RENDERED from the USAGE map so the two
// copies of each signature cannot drift again. #36's presence-only check could not see a missing
// placeholder inside an otherwise-present string, so every usage assertion here pins CONTENT.
//
// Positive control throughout: the harness posts through a real CoordService over a mock github,
// and the arms that assert NOTHING was written (refusals) sit beside arms that prove the same
// shape DOES write, so an empty `posted` array cannot pass vacuously.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Cli } = require('../../src/cli')
const { CoordService } = require('../../src/coord')
const { USAGE } = require('../../src/coord/issueNumber')

const harness = () => {
  const out = []
  const err = []
  const posted = []
  const issue = {
    number: 34,
    body: '## Files\nsrc/foo.js\n\n## Goal\nTest',
    labels: [{ name: 'status:unclaimed' }],
  }
  const cli = Cli({
    github: { repo: 'Sullux/pi-agents' },
    coordFactory: ({ agent }) =>
      CoordService({
        github: {
          issueKind: async () => ({ isPullRequest: false, state: 'OPEN' }),
          viewIssue: async () => ({
            ...issue,
            comments: [
              { body: `**CLAIM** | agent: ${agent} | at: 1700000000000` },
            ],
          }),
          listIssues: async () => [issue],
          commentIssue: async (num, body) => {
            posted.push({ num, body })
          },
          editIssue: async () => {},
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
  const runRelease = (...args) => cli.run(['coord', 'release', '34', ...args])
  return { out, err, posted, runRelease, cli }
}

const releaseLines = (posted) =>
  posted.filter((p) => p.body.startsWith('**RELEASE**'))

describe('coord release reads the positional, refuses silence, and stops duplicating its usage (#154)', () => {
  it('positional reason lands in the RELEASE comment - the call shape status/review teach', async () => {
    const h = harness()
    assert.equal(await h.runRelease('standing down - delta claimed first'), 0)
    const lines = releaseLines(h.posted)
    assert.equal(
      lines.length,
      1,
      `one release comment: ${JSON.stringify(h.posted)}`,
    )
    assert.ok(
      lines[0].body.includes('reason: standing down - delta claimed first'),
      lines[0].body,
    )
    assert.ok(
      !lines[0].body.includes('unspecified'),
      `the silent-default sentence must be gone: ${lines[0].body}`,
    )
  })

  it('--reason keeps working for current callers', async () => {
    const h = harness()
    assert.equal(await h.runRelease('--reason', 'flagged because'), 0)
    const lines = releaseLines(h.posted)
    assert.equal(lines.length, 1)
    assert.ok(lines[0].body.includes('reason: flagged because'), lines[0].body)
  })

  it('neither form refuses: exit 1, NO comment posted, and the error names --reason', async () => {
    const h = harness()
    assert.equal(
      await h.runRelease(),
      1,
      `${h.out.join(' | ')}\n${h.err.join(' | ')}`,
    )
    // control: the same harness DOES write when the reason exists (arms above) - zero here is
    // the refusal, not a harness that never posts
    assert.equal(
      releaseLines(h.posted).length,
      0,
      `a bare release must write nothing: ${JSON.stringify(h.posted)}`,
    )
    const text = h.err.join('\n')
    assert.ok(text.includes('missing message'), text)
    assert.ok(
      text.includes('--reason'),
      `the usage line must name the flag: ${text}`,
    )
    assert.ok(
      text.includes(`Usage: page coord ${USAGE.release}.`),
      `error prints the map verbatim: ${text}`,
    )
  })

  it('both forms: the flag wins and the positional is not concatenated in', async () => {
    const h = harness()
    assert.equal(
      await h.runRelease('--reason', 'FLAGTEXT', 'POSITIONALTEXT'),
      0,
    )
    const lines = releaseLines(h.posted)
    assert.equal(lines.length, 1)
    assert.ok(lines[0].body.includes('reason: FLAGTEXT'), lines[0].body)
    assert.ok(
      !lines[0].body.includes('POSITIONALTEXT'),
      `positional must not ride along: ${lines[0].body}`,
    )
  })

  it('a valueless --reason refuses too - it used to post the literal string true', async () => {
    const h = harness()
    assert.equal(
      await h.runRelease('--reason'),
      1,
      `${h.out.join(' | ')}\n${h.err.join(' | ')}`,
    )
    assert.equal(releaseLines(h.posted).length, 0, JSON.stringify(h.posted))
  })

  it('the unspecified fallback is reachable only from the library, never the CLI', async () => {
    const posted = []
    const coord = CoordService({
      github: {
        issueKind: async () => ({ isPullRequest: false, state: 'OPEN' }),
        viewIssue: async () => ({ number: 34, labels: [], comments: [] }),
        listIssues: async () => [],
        commentIssue: async (num, body) => {
          posted.push({ num, body })
        },
        editIssue: async () => {},
      },
      agent: 'charlie',
      human: 'Sullux',
      now: () => 1700000000000,
    })
    await coord.release(34)
    const lines = releaseLines(posted)
    assert.equal(
      lines.length,
      1,
      'library-direct release still writes a comment (control)',
    )
    assert.ok(
      lines[0].body.includes('reason: unspecified'),
      `library default kept: ${lines[0].body}`,
    )
  })

  it('USAGE.release content: placeholder AND positional twin present, not mere truthiness', () => {
    assert.ok(USAGE.release.includes('[--reason "<why>"'), USAGE.release)
    assert.ok(
      USAGE.release.includes(' | "<why>"'),
      `positional twin must show: ${USAGE.release}`,
    )
  })

  it('the help block renders every mutating verb FROM USAGE - one source, drift unmade', async () => {
    const h = harness()
    await h.cli.run(['--help'])
    const help = h.out.join('\n')
    // control: the section itself rendered, so a vacuous all-contains pass is impossible
    assert.ok(help.includes('Coordination Commands:'), help.slice(0, 400))
    for (const verb of ['claim', 'release', 'status', 'review', 'done']) {
      assert.ok(
        help.includes(`coord ${USAGE[verb]}`),
        `help must show USAGE[${verb}] verbatim: ${help}`,
      )
    }
    assert.ok(
      !help.includes('coord release <issue> [--reason]   '),
      'the old hand copy must be GONE',
    )
  })
})
