const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
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

// #865: provisioning pins, on the REAL fs in a temp dir. The mock-fs pins above
// cannot reach the copy branches at all - their existsSync reports the seed source as
// absent, so a copy is skipped and only the inline fallback can ever run. Box 1 asks
// for the LINKED PATHS to exist after a fresh provisioning, not for a copy function
// to have been called, so these assert on-disk effects.
describe('ProfileManager provisioning (#865)', () => {
  const provision = (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-865-'))
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
    const mgr = ProfileManager({ fs, homeDir: workspace })
    mgr.ensureProfileStructure(workspace, 'prov')
    return {
      workspace,
      mgr,
      skillDir: path.join(workspace, '.agents', 'skills', 'coordinate'),
    }
  }

  const relativeLinksOf = (skillDir) => {
    const body = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')
    return [...body.matchAll(/\]\(([^)\s]+)\)/g)]
      .map((m) => m[1])
      .filter((l) => !/^(https?:|mailto:|#)/.test(l))
  }

  it('provisions references/ so every relative link in SKILL.md resolves', (t) => {
    const { skillDir } = provision(t)
    assert.ok(
      fs.existsSync(path.join(skillDir, 'SKILL.md')),
      'SKILL.md was not provisioned',
    )

    const relative = relativeLinksOf(skillDir)
    // non-vacuity floor: the seed carries exactly three relative links, so a regex
    // that silently matched nothing would make the dead-link assertion pass empty.
    assert.equal(
      relative.length,
      3,
      `expected the seed's 3 relative links, found ${relative.length}`,
    )

    const dead = relative
      .map((l) => l.split('#')[0])
      .filter((p) => p && !fs.existsSync(path.resolve(skillDir, p)))
    assert.deepEqual(
      dead,
      [],
      'provisioned SKILL.md links that resolve to nothing',
    )

    for (const f of ['coordination-best-practices-3.md', 'protocol.md']) {
      const p = path.join(skillDir, 'references', f)
      assert.ok(fs.existsSync(p), `references/${f} was not provisioned`)
      assert.ok(
        fs.statSync(p).size > 1000,
        `references/${f} was provisioned empty`,
      )
    }
  })

  it("resolves the seed's skill-dir token and leaks no machine-specific path", (t) => {
    const { skillDir } = provision(t)
    const body = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')

    assert.ok(
      !body.includes('{{COORD_SKILL_DIR}}'),
      'the seed token survived provisioning',
    )
    assert.ok(
      body.includes(`COORD="node ${skillDir}/scripts/coord.js"`),
      "the documented invocation is not this workspace's own absolute skill dir",
    )
    assert.ok(
      fs.existsSync(path.join(skillDir, 'scripts', 'coord.js')),
      'the invocation names a file that does not exist',
    )

    // item 5 of #865: the seed must not be a copy of an installed file, or every new
    // workspace inherits one box's absolute paths.
    assert.deepEqual(
      body.split('\n').filter((l) => l.includes('/home/')),
      [],
      'a provisioned SKILL.md hardcodes a machine-specific path',
    )
  })

  it('the provisioned coord.js propagates a non-zero exit status (#816)', (t) => {
    const { workspace, skillDir } = provision(t)
    const coordJs = path.join(skillDir, 'scripts', 'coord.js')
    assert.ok(fs.existsSync(coordJs), 'coord.js was not provisioned')

    const bin = path.join(workspace, 'fakebin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'page'), '#!/usr/bin/env bash\nexit 3\n')
    fs.chmodSync(path.join(bin, 'page'), 0o755)

    const res = spawnSync(process.execPath, [coordJs, 'board'], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      encoding: 'utf8',
    })
    // 3 proves the fake `page` ran AND its status survived the shim. The pre-fix
    // 3-line shim never called process.exit, so this read 0 - and a shim that cannot
    // find `page` at all takes its error branch and exits 1. So 3 discriminates both
    // the swallowed-status defect and a pin that passed without running anything.
    assert.equal(res.status, 3)
  })

  it("re-provisioning does not clobber a workspace's own edits", (t) => {
    const { workspace, mgr, skillDir } = provision(t)
    const target = path.join(skillDir, 'references', 'protocol.md')
    assert.ok(
      fs.existsSync(target),
      'non-vacuity: the file must exist before editing it',
    )
    fs.writeFileSync(target, 'edited locally\n')

    mgr.ensureProfileStructure(workspace, 'prov')

    assert.equal(fs.readFileSync(target, 'utf8'), 'edited locally\n')
  })
})
