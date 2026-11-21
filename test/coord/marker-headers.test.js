const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { CoordService } = require('../../src/coord')

// #167 box 2: every marker template renders its `at:` through the ONE formatter. These arms
// drive the real verbs with an injected clock and pin the FULL rendered header string - not
// the formatter in isolation - so a sixth verb that forgets the formatter reddens here.
const STAMP = 1795290865225

const FakeGithub = () => {
  const issue = {
    number: 42,
    title: 't',
    labels: [],
    comments: [],
    body: '## Files\n\nsrc/x.js\n',
  }
  const hub = {
    number: 4,
    title: 'hub',
    labels: [{ name: 'hub' }],
    comments: [],
    body: '',
  }
  const byNumber = { 42: issue, 4: hub }
  const calls = []
  return {
    calls,
    repo: 'test/repo',
    issueKind: async () => ({ isPullRequest: false, state: 'OPEN' }),
    viewIssue: async (n) => byNumber[n],
    listIssues: async () => [issue, hub],
    commentIssue: async (n, body) => {
      byNumber[n].comments.push({ body, createdAt: '2026-11-21T20:00:00Z' })
      calls.push([n, body])
      return ''
    },
    editIssue: async () => '',
    closeIssue: async () => '',
  }
}

const firstLine = (body) => body.split('\n')[0]

describe('#167 every marker renders one epoch-ms stamp from the injected clock', () => {
  const coord = (github) =>
    CoordService({ github, agent: 'bravo', human: 'Sullux', now: () => STAMP })

  it('CLAIM header', async () => {
    const github = FakeGithub()
    const res = await coord(github).claim(42, { plan: 'plan: x', eta: '30m' })
    assert.equal(res.ok, true, res.error)
    const body = github.calls.find(([n]) => n === 42)[1]
    assert.equal(
      firstLine(body),
      `**CLAIM** | agent: agent-bravo | human: @Sullux | at: ${STAMP}`,
    )
  })

  it('STATUS header', async () => {
    const github = FakeGithub()
    const res = await coord(github).status(42, 'working')
    assert.equal(res.ok, true, res.error)
    assert.equal(
      firstLine(github.calls[0][1]),
      `**STATUS** | agent: agent-bravo | at: ${STAMP}`,
    )
  })

  it('REVIEW header', async () => {
    const github = FakeGithub()
    const res = await coord(github).review(42, { text: 'LGTM' })
    assert.equal(res.ok, true, res.error)
    assert.equal(
      firstLine(github.calls[0][1]),
      `**REVIEW** | agent: agent-bravo | at: ${STAMP}`,
    )
  })

  it('DONE header', async () => {
    const github = FakeGithub()
    const res = await coord(github).done(42, { force: true, text: 'shipped' })
    assert.equal(res.ok, true, res.error)
    assert.equal(
      firstLine(github.calls[0][1]),
      `**DONE** | agent: agent-bravo | at: ${STAMP}`,
    )
  })

  it('SYNC header (hub verb)', async () => {
    const github = FakeGithub()
    const res = await coord(github).hub('fleet update')
    assert.equal(res.ok, true, res.error)
    const body = github.calls.find(([n]) => n === 4)[1]
    assert.equal(
      firstLine(body),
      `**SYNC** | agent: agent-bravo | human: @Sullux | at: ${STAMP}`,
    )
  })
})
