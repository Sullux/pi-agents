const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { WorkspaceManager, normalizeRepoUrl } = require('../../src/workspace')

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
    assert.ok(
      createdFiles['/mock/agents/alpha/projects/portal.env'].includes(
        'PORT=3001',
      ),
    )
    assert.ok(createdFiles['/mock/agents/alpha/projects/portal.md'])
  })

  it('normalizes repository shorthand and executes clone', () => {
    assert.equal(
      normalizeRepoUrl('Sullux/pitcairn-portal'),
      'git@github.com:Sullux/pitcairn-portal.git',
    )
    assert.equal(
      normalizeRepoUrl('https://github.com/Sullux/pitcairn-portal'),
      'https://github.com/Sullux/pitcairn-portal',
    )

    let executedCommands = []
    let files = {}

    const mockFs = {
      existsSync: (p) => Boolean(files[p]),
      mkdirSync: () => {},
      writeFileSync: (p, data) => {
        files[p] = data
      },
    }

    const mockExec = (cmd, args, opts) => {
      executedCommands.push({ cmd, args, opts })
    }

    const mgr = WorkspaceManager({
      fs: mockFs,
      agentsRoot: '/mock/agents',
      exec: mockExec,
    })

    const wsPath = mgr.clone('alpha', 'pp', 'Sullux/pitcairn-portal')
    assert.equal(wsPath, '/mock/agents/alpha/pp')
    assert.equal(executedCommands[0].cmd, 'git')
    assert.deepEqual(executedCommands[0].args, [
      'clone',
      'git@github.com:Sullux/pitcairn-portal.git',
      '/mock/agents/alpha/pp',
    ])
    assert.ok(files['/mock/agents/alpha/projects/pp.env'])
  })
})
