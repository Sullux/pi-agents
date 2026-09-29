const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { ProfileManager } = require('../../src/config/profile')

describe('ProfileManager', () => {
  it('resolves active profile with correct precedence (flag > env > config > default)', () => {
    let mockFiles = {
      '/mock/home/.config/page/config.json': JSON.stringify({
        activeProfile: 'work',
      }),
      '/mock/home/.config/page/profiles.json': JSON.stringify({
        work: { path: '/mock/work/agents' },
        personal: { path: '/mock/home/agents' },
      }),
    }

    const mockFs = {
      existsSync: (p) => Boolean(mockFiles[p]),
      readFileSync: (p) => mockFiles[p] || '',
      writeFileSync: (p, data) => {
        mockFiles[p] = data
      },
      mkdirSync: () => {},
    }

    const mgr = ProfileManager({ fs: mockFs, homeDir: '/mock/home' })

    // 1. Config activeProfile
    assert.equal(mgr.resolveActiveProfileName({}), 'work')

    // 2. Env variable overrides config
    assert.equal(
      mgr.resolveActiveProfileName({}, { PAGE_PROFILE: 'personal' }),
      'personal',
    )

    // 3. CLI flag overrides env and config
    assert.equal(
      mgr.resolveActiveProfileName(
        { profile: 'work' },
        { PAGE_PROFILE: 'personal' },
      ),
      'work',
    )
  })

  it('addProfile initializes directory structure and registers profile', () => {
    let createdDirs = []
    let createdFiles = {}

    const mockFs = {
      existsSync: (p) => Boolean(createdFiles[p]),
      readFileSync: (p) => createdFiles[p] || '',
      writeFileSync: (p, data) => {
        createdFiles[p] = data
      },
      mkdirSync: (p) => {
        createdDirs.push(p)
      },
    }

    const mgr = ProfileManager({ fs: mockFs, homeDir: '/mock/home' })
    const profile = mgr.addProfile('personal', '/mock/home/agents')

    assert.equal(profile.name, 'personal')
    assert.equal(profile.path, '/mock/home/agents')
    assert.ok(createdFiles['/mock/home/agents/.page/profile.json'])
    assert.ok(createdFiles['/mock/home/agents/.page/profile.env'])
    assert.ok(
      createdFiles[
        '/mock/home/agents/.agents/skills/coordinate/scripts/coord.js'
      ],
    )
    assert.ok(createdFiles['/mock/home/.config/page/profiles.json'])

    const list = mgr.listProfiles()
    assert.equal(list.length, 1)
    assert.equal(list[0].name, 'personal')
  })

  it('getProfile ensures structure exists on disk even if previously missing', () => {
    let createdFiles = {}
    let mockProfiles = {
      default: { path: '/mock/home/agents' },
    }

    const mockFs = {
      existsSync: (p) =>
        p.includes('profiles.json') ? true : Boolean(createdFiles[p]),
      readFileSync: (p) =>
        p.includes('profiles.json')
          ? JSON.stringify(mockProfiles)
          : createdFiles[p] || '',
      writeFileSync: (p, data) => {
        createdFiles[p] = data
      },
      mkdirSync: () => {},
    }

    const mgr = ProfileManager({ fs: mockFs, homeDir: '/mock/home' })
    const profile = mgr.getProfile('default')

    assert.equal(profile.name, 'default')
    assert.ok(createdFiles['/mock/home/agents/.page/profile.json'])
    assert.ok(
      createdFiles[
        '/mock/home/agents/.agents/skills/coordinate/scripts/coord.js'
      ],
    )
  })

  it('useProfile sets active profile', () => {
    let createdFiles = {
      '/mock/home/.config/page/profiles.json': JSON.stringify({
        work: { path: '/mock/work/agents' },
        personal: { path: '/mock/home/agents' },
      }),
    }

    const mockFs = {
      existsSync: (p) => Boolean(createdFiles[p]),
      readFileSync: (p) => createdFiles[p] || '',
      writeFileSync: (p, data) => {
        createdFiles[p] = data
      },
      mkdirSync: () => {},
    }

    const mgr = ProfileManager({ fs: mockFs, homeDir: '/mock/home' })
    mgr.useProfile('work')

    const config = JSON.parse(
      createdFiles['/mock/home/.config/page/config.json'],
    )
    assert.equal(config.activeProfile, 'work')
  })
})
