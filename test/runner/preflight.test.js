const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { checkBacklogAvailability } = require('../../src/runner/preflight')

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

  it('returns ready if open PRs exist', async () => {
    const issues = [
      {
        number: 20,
        labels: [{ name: 'status:claimed' }],
        comments: [{ body: '**CLAIM** | agent: bravo' }],
      },
    ]
    const github = {
      listIssues: async () => issues,
      listPrs: async () => [{ number: 100 }],
    }

    const res = await checkBacklogAvailability({ github, agent: 'alpha' })
    assert.equal(res.status, 'ready')
    assert.equal(res.reason, 'open_prs')
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
