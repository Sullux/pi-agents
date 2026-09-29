const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { ConfigLoader } = require('../../src/config')

describe('ConfigLoader', () => {
  it('loads default system config when file does not exist', () => {
    const mockFs = {
      existsSync: () => false,
      readFileSync: () => '',
      writeFileSync: () => {},
    }
    const loader = ConfigLoader({ fs: mockFs, homeDir: '/mock/home' })
    const system = loader.getSystemConfig()

    assert.equal(system.agentsRoot, '/mock/home/agents')
    assert.equal(system.defaultModel, 'anthropic:claude-3-5-sonnet-latest')
    assert.equal(system.defaultThinking, 'low')
  })

  it('merges existing system config over defaults', () => {
    const mockFs = {
      existsSync: (path) => path.includes('config.json'),
      readFileSync: () =>
        JSON.stringify({
          defaultModel: 'custom:model',
          defaultThinking: 'off',
        }),
      writeFileSync: () => {},
    }
    const loader = ConfigLoader({ fs: mockFs, homeDir: '/mock/home' })
    const system = loader.getSystemConfig()

    assert.equal(system.agentsRoot, '/mock/home/agents')
    assert.equal(system.defaultModel, 'custom:model')
    assert.equal(system.defaultThinking, 'off')
  })

  it('resolves 4-tier environment variables correctly', () => {
    const files = {
      '/mock/home/.config/page/config.json': JSON.stringify({
        defaultEnv: { GLOBAL_VAR: 'global' },
      }),
      '/mock/home/.config/page/projects/portal.json': JSON.stringify({
        repo: 'Sullux/pitcairn-portal',
        defaultEnv: { PORT: '3000', PROJECT_NAME: 'portal' },
      }),
      '/mock/home/agents/alpha/agent.json': JSON.stringify({
        model: 'custom:alpha-model',
        thinking: 'medium',
        env: { AGENT_VAR: 'alpha-custom' },
      }),
      '/mock/home/agents/alpha/projects/portal.env':
        'PORT=3001\nINSTANCE_VAR=delta-test\n',
    }

    const mockFs = {
      existsSync: (path) => Boolean(files[path]),
      readFileSync: (path) => files[path] || '',
      writeFileSync: () => {},
    }

    const loader = ConfigLoader({ fs: mockFs, homeDir: '/mock/home' })
    const resolved = loader.resolveInstanceEnv('alpha', 'portal')

    assert.equal(resolved.GLOBAL_VAR, 'global')
    assert.equal(resolved.PROJECT_NAME, 'portal')
    assert.equal(resolved.AGENT_VAR, 'alpha-custom')
    assert.equal(resolved.PORT, '3001') // Instance overrides project default
    assert.equal(resolved.INSTANCE_VAR, 'delta-test')
    assert.equal(resolved.COORD_AGENT, 'agent-alpha')
  })
})
