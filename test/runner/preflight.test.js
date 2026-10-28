const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const {
  checkBacklogAvailability,
  isPrAuthoredByAgent,
  isPrReviewedByAgent,
} = require('../../src/runner/preflight')

describe('Runner: Backlog Preflight', () => {
  it('returns ready if agent owns an active claimed issue', async () => {
    const issues = [
      {
        number: 10,
        labels: [{ name: 'status:claimed' }],
        comments: [{ body: '**CLAIM** | agent: agent-alpha' }],
      },
    ]
    const github = {
      listIssues: async () => issues,
      listPrs: async () => [],
    }

    const res = await checkBacklogAvailability({ github, agent: 'alpha' })
    assert.equal(res.status, 'ready')
    assert.equal(res.reason, 'owned_claims')
  })

  it('does not count status:in-review issues as active owned_claims', async () => {
    const issues = [
      {
        number: 10,
        labels: [{ name: 'status:claimed' }, { name: 'status:in-review' }],
        comments: [{ body: '**CLAIM** | agent: agent-alpha' }],
      },
    ]
    const github = {
      listIssues: async () => issues,
      listPrs: async () => [],
    }

    const res = await checkBacklogAvailability({ github, agent: 'alpha' })
    assert.equal(res.status, 'idle_busy')
    assert.equal(res.waitSeconds, 60)
  })

  it('returns unclaimed_tasks when owned claims are in-review but unclaimed tasks exist', async () => {
    const issues = [
      {
        number: 10,
        labels: [{ name: 'status:claimed' }, { name: 'status:in-review' }],
        comments: [{ body: '**CLAIM** | agent: agent-alpha' }],
      },
      {
        number: 11,
        labels: [{ name: 'status:unclaimed' }, { name: 'type:task' }],
        comments: [],
      },
    ]
    const github = {
      listIssues: async () => issues,
      listPrs: async () => [],
    }

    const res = await checkBacklogAvailability({ github, agent: 'alpha' })
    assert.equal(res.status, 'ready')
    assert.equal(res.reason, 'unclaimed_tasks')
  })

  it('returns ready if actionable unclaimed issues exist', async () => {
    const issues = [
      {
        number: 20,
        labels: [{ name: 'status:unclaimed' }, { name: 'type:task' }],
        comments: [],
      },
    ]
    const github = {
      listIssues: async () => issues,
      listPrs: async () => [],
    }

    const res = await checkBacklogAvailability({ github, agent: 'alpha' })
    assert.equal(res.status, 'ready')
    assert.equal(res.reason, 'unclaimed_tasks')
  })

  it('returns ready if open PRs exist and have not been reviewed by agent', async () => {
    const issues = [
      {
        number: 20,
        labels: [{ name: 'status:claimed' }],
        comments: [{ body: '**CLAIM** | agent: bravo' }],
      },
    ]
    const github = {
      listIssues: async () => issues,
      listPrs: async () => [{ number: 100, headRefOid: 'abc1234567' }],
    }

    const res = await checkBacklogAvailability({ github, agent: 'alpha' })
    assert.equal(res.status, 'ready')
    assert.equal(res.reason, 'open_prs')
    assert.equal(res.count, 1)
  })

  it('returns idle_busy when all open PRs are already reviewed by this agent', async () => {
    const issues = [
      {
        number: 20,
        labels: [{ name: 'status:claimed' }],
        comments: [{ body: '**CLAIM** | agent: bravo' }],
      },
    ]
    const github = {
      listIssues: async () => issues,
      listPrs: async () => [
        {
          number: 100,
          headRefOid: 'abc1234567890',
          comments: [
            {
              body: '**REVIEW** | agent: agent-alpha | verdict: **APPROVE** | head: `abc1234`',
            },
          ],
        },
      ],
    }

    const res = await checkBacklogAvailability({ github, agent: 'alpha' })
    assert.equal(res.status, 'idle_busy')
    assert.equal(res.reason, 'peer_contention')
    assert.equal(res.waitSeconds, 60)
  })

  it('returns ready open_prs when a PR head moved after this agent reviewed an older commit', async () => {
    const issues = [
      {
        number: 20,
        labels: [{ name: 'status:claimed' }],
        comments: [{ body: '**CLAIM** | agent: bravo' }],
      },
    ]
    const github = {
      listIssues: async () => issues,
      listPrs: async () => [
        {
          number: 100,
          headRefOid: 'def5678901234',
          comments: [
            {
              body: '**REVIEW** | agent: agent-alpha | verdict: **APPROVE** | head: `abc1234`',
            },
          ],
        },
      ],
    }

    const res = await checkBacklogAvailability({ github, agent: 'alpha' })
    assert.equal(res.status, 'ready')
    assert.equal(res.reason, 'open_prs')
    assert.equal(res.count, 1)
  })

  it('returns idle_busy when the only open PR is authored by this agent', async () => {
    const issues = [
      {
        number: 20,
        labels: [{ name: 'status:claimed' }, { name: 'status:in-review' }],
        comments: [{ body: '**CLAIM** | agent: agent-alpha' }],
      },
    ]
    const github = {
      listIssues: async () => issues,
      listPrs: async () => [
        {
          number: 100,
          headRefName: 'fix/20-my-feature',
          closingIssuesReferences: [{ number: 20 }],
        },
      ],
    }

    const res = await checkBacklogAvailability({ github, agent: 'alpha' })
    assert.equal(res.status, 'idle_busy')
    assert.equal(res.reason, 'peer_contention')
  })

  it('returns idle_busy when all issues are claimed by peers and 0 PRs', async () => {
    const issues = [
      {
        number: 30,
        labels: [{ name: 'status:claimed' }],
        comments: [{ body: '**CLAIM** | agent: bravo' }],
      },
    ]
    const github = {
      listIssues: async () => issues,
      listPrs: async () => [],
    }

    const res = await checkBacklogAvailability({ github, agent: 'alpha' })
    assert.equal(res.status, 'idle_busy')
    assert.equal(res.waitSeconds, 60)
  })

  it('returns idle_empty when 0 non-hub issues exist', async () => {
    const issues = [
      {
        number: 4,
        labels: [{ name: 'hub' }],
        comments: [],
      },
    ]
    const github = {
      listIssues: async () => issues,
      listPrs: async () => [],
    }

    const res = await checkBacklogAvailability({ github, agent: 'alpha' })
    assert.equal(res.status, 'idle_empty')
    assert.equal(res.waitSeconds, 300)
  })
})

describe('Runner: PR Authorship and Review Helpers', () => {
  it('isPrAuthoredByAgent detects authorship via comments, branch, or closing ref', () => {
    const myIssues = [{ number: 50 }]
    assert.equal(
      isPrAuthoredByAgent(
        { closingIssuesReferences: [{ number: 50 }] },
        'delta',
        myIssues,
      ),
      true,
    )
    assert.equal(
      isPrAuthoredByAgent(
        { headRefName: 'fix/50-something' },
        'delta',
        myIssues,
      ),
      true,
    )
    assert.equal(
      isPrAuthoredByAgent(
        { comments: [{ body: '(agent-delta, the author)' }] },
        'delta',
        [],
      ),
      true,
    )
    assert.equal(
      isPrAuthoredByAgent({ headRefName: 'fix/99-other' }, 'delta', myIssues),
      false,
    )
  })

  it('isPrReviewedByAgent detects reviews and retractions citing shortSha', () => {
    const pr = {
      headRefOid: 'dcc9637e5ebc2d284750c2b384de993cd9e057a5',
      comments: [
        {
          body: '**RETRACTION of my two APPROVEs** | agent: agent-delta | head `dcc9637` | at: 2026-10-28T16:30:15Z',
        },
      ],
    }
    assert.equal(isPrReviewedByAgent(pr, 'delta'), true)
    assert.equal(isPrReviewedByAgent(pr, 'echo'), false)
  })
})
