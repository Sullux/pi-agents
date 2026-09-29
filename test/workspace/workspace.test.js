const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { WorkspaceManager } = require('../../src/workspace')

describe('WorkspaceManager', () => {
  it('detects existing agent project clone path', () => {
    const mockFs = {
      existsSync: (p) => p.includes('portal'),
      mkdirSync: () => {},
    }
    const mgr = WorkspaceManager({ fs: mockFs, agentsRoot: '/mock/agents' })
    const wsPath = mgr.getWorkspacePath('alpha', 'portal')

    assert.equal(wsPath, '/mock/agents/alpha/portal')
    assert.equal(mgr.exists('alpha', 'portal'), true)
  })

  it('provisions instance files if missing', () => {
    let createdFiles = {}
    const mockFs = {
      existsSync: (p) => Boolean(createdFiles[p]),
      mkdirSync: () => {},
      writeFileSync: (p, data) => {
        createdFiles[p] = data
      },
    }

    const mgr = WorkspaceManager({ fs: mockFs, agentsRoot: '/mock/agents' })
    mgr.provisionInstanceFiles('alpha', 'portal', { defaultPort: 3001 })

    assert.ok(createdFiles['/mock/agents/alpha/projects/portal.env'])
    assert.ok(createdFiles['/mock/agents/alpha/projects/portal.env'].includes('PORT=3001'))
    assert.ok(createdFiles['/mock/agents/alpha/projects/portal.md'])
  })
})
