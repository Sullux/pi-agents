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

// #871: the tracked seed `.agents/skills/coordinate/scripts/coord.js` is a THIRD shim copy, and
// the one `setup-agents.sh:28-30` runs at bootstrap. #865 hardened the copy profile.js provisions;
// this file still said `process.exit(result.status || 0)` with no `result.error` branch, so a
// signal-kill or a `page` that could not be run at all read as SUCCESS - and the bootstrap's
// `|| { echo "Notice: ... returned non-zero" }` guard never fired, because there was nothing to
// catch. These pins drive the TRACKED file's own bytes, read at test time: not a hand-written mock,
// and not profile.js's generated string, so a future edit to either one cannot make them pass.
describe('tracked seed coord.js status propagation (#871)', () => {
  const TRACKED_SEED = path.join(
    __dirname,
    '../../.agents/skills/coordinate/scripts/coord.js',
  )

  const withFakePage = (ws, body) => {
    const bin = path.join(ws, 'fakebin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'page'), `#!/usr/bin/env bash\n${body}\n`)
    fs.chmodSync(path.join(bin, 'page'), 0o755)
    return bin
  }

  // Stage the tracked file at the SAME repo-relative depth inside a temp workspace. The depth is
  // load-bearing: findPageBin resolves `../../../../bin/page`, so staging it four levels down puts
  // that resolution inside the temp dir where it cannot exist, and the PATH fallback becomes
  // deterministic instead of depending on whether a real /bin/page is installed on this box.
  const stageTracked = (t) => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-871-'))
    t.after(() => fs.rmSync(ws, { recursive: true, force: true }))
    const dir = path.join(ws, '.agents', 'skills', 'coordinate', 'scripts')
    fs.mkdirSync(dir, { recursive: true })
    const src = fs.readFileSync(TRACKED_SEED, 'utf8')
    assert.ok(src.length > 100, 'non-vacuity: the tracked seed read back empty')
    const coordJs = path.join(dir, 'coord.js')
    fs.writeFileSync(coordJs, src)
    // If a local bin/page existed here, every case below would measure THAT and the fake `page` on
    // PATH would never run - the pins would go green while testing nothing.
    assert.ok(
      !fs.existsSync(path.resolve(dir, '../../../../bin/page')),
      'findPageBin would bypass the fake page on PATH',
    )
    return { ws, coordJs }
  }

  const stageProvisioned = (t) => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-871p-'))
    t.after(() => fs.rmSync(ws, { recursive: true, force: true }))
    const mgr = ProfileManager({ fs, homeDir: ws })
    mgr.ensureProfileStructure(ws, 'prov')
    const coordJs = path.join(
      ws,
      '.agents',
      'skills',
      'coordinate',
      'scripts',
      'coord.js',
    )
    assert.ok(fs.existsSync(coordJs), 'the shim was not provisioned')
    return { ws, coordJs }
  }

  // process.execPath is absolute ON PURPOSE. An earlier version of this probe exported a bogus PATH
  // and invoked `node` by name, so it measured bash's 127 for a missing interpreter rather than the
  // shim's exit code - both shims "agreed" on 127 and the case looked covered.
  // A doctored PATH still has to carry the real one when a fake `page` is staged: its shebang is
  // `#!/usr/bin/env bash`, so `env` must be able to FIND bash. Setting PATH to the fake bin alone
  // made every staged case fail on a missing interpreter, which reads like a shim defect and is
  // not. The no-bin case wants the opposite - a PATH with no `page` anywhere - and cannot append
  // the real one, because this box has a genuine `page` installed that would answer instead.
  const pathFor = (bin) =>
    bin ? `${bin}:${process.env.PATH}` : '/nonexistent-871'

  const runShim = (coordJs, { bin, witness }) =>
    spawnSync(process.execPath, [coordJs, 'board'], {
      env: {
        ...process.env,
        PATH: pathFor(bin),
        WITNESS_871: witness ?? '',
      },
      encoding: 'utf8',
    })

  const witnessOf = (witness) => fs.readFileSync(witness, 'utf8').trim()

  it('propagates a non-zero status, and proves the fake page ran', (t) => {
    const { ws, coordJs } = stageTracked(t)
    const witness = path.join(ws, 'witness')
    const bin = withFakePage(ws, `echo ran > "$WITNESS_871"\nexit 3`)

    const res = runShim(coordJs, { bin, witness })

    // 3 discriminates three ways at once: a swallowed status reads 0, the error branch reads 1,
    // and only a propagated child status reads 3.
    assert.equal(res.status, 3)
    assert.equal(witnessOf(witness), 'ran', 'the fake page never ran')
  })

  it('exits 0 on success, so a green coord call still reads green', (t) => {
    const { ws, coordJs } = stageTracked(t)
    const witness = path.join(ws, 'witness')
    const bin = withFakePage(ws, `echo ran > "$WITNESS_871"\nexit 0`)

    const res = runShim(coordJs, { bin, witness })

    assert.equal(res.status, 0)
    assert.equal(witnessOf(witness), 'ran', 'the fake page never ran')
  })

  it('reports failure when page is killed by a signal, not success', (t) => {
    const { ws, coordJs } = stageTracked(t)
    const witness = path.join(ws, 'witness')
    const bin = withFakePage(ws, `echo ran > "$WITNESS_871"\nkill -TERM $$`)

    const res = runShim(coordJs, { bin, witness })

    // spawnSync reports status null for a signal death, and `null || 0` is 0 - so the pre-fix
    // shim called a killed `page` a success. `?? 1` is the difference this pin exists for.
    assert.equal(witnessOf(witness), 'ran', 'the fake page never ran')
    assert.equal(res.status, 1, 'a signal-killed page must not read as success')
  })

  it('takes the error branch and says why when page cannot be run at all', (t) => {
    const { coordJs } = stageTracked(t)

    // No bin at all, so PATH resolves `page` to nothing and spawnSync sets result.error.
    const res = runShim(coordJs, {})

    assert.equal(res.status, 1)
    assert.match(
      res.stderr,
      /cannot run `page coord`/,
      'the failure is silent, so a bootstrap cannot tell the user what went wrong',
    )
    assert.match(res.stderr, /ENOENT/)
  })

  it('keeps the findPageBin bootstrap fallback: <repo>/bin/page beats PATH', (t) => {
    const { ws, coordJs } = stageTracked(t)
    // The fake on PATH exits 3; a repo-local bin/page exits 7. Only a shim that still prefers the
    // local bin reads 7. This is the constraint #871 names - the hardened provisioned copy spawns
    // bare `page` and would regress bootstrap on a fresh clone where `page` is not on PATH yet.
    const bin = withFakePage(ws, 'exit 3')
    const localBin = path.join(ws, 'bin')
    fs.mkdirSync(localBin, { recursive: true })
    fs.writeFileSync(
      path.join(localBin, 'page'),
      '#!/usr/bin/env bash\nexit 7\n',
    )
    fs.chmodSync(path.join(localBin, 'page'), 0o755)

    const res = runShim(coordJs, { bin })

    assert.equal(
      res.status,
      7,
      'findPageBin no longer prefers <repo>/bin/page, so bootstrap on a fresh clone is broken',
    )
  })

  it('the tracked seed and the provisioned shim agree on all three status cases', (t) => {
    // #871 box 3: nothing tied the two copies together, which is how they drifted in the first
    // place - #865 fixed the generator and the tracked file it does not use stayed stale. This
    // drives BOTH real files through the same fakes and compares observed exit codes, so a future
    // edit to either one that changes status handling reddens here.
    const cases = [
      { name: 'non-zero status', body: 'exit 3', want: 3, bin: true },
      { name: 'success', body: 'exit 0', want: 0, bin: true },
      { name: 'signal-kill', body: 'kill -TERM $$', want: 1, bin: true },
      { name: 'page unrunnable', body: '', want: 1, bin: false },
    ]

    const tracked = stageTracked(t)
    const provisioned = stageProvisioned(t)

    for (const c of cases) {
      const bin = c.bin ? withFakePage(tracked.ws, c.body) : undefined
      const provBin = c.bin ? withFakePage(provisioned.ws, c.body) : undefined

      const a = runShim(tracked.coordJs, { bin })
      const b = runShim(provisioned.coordJs, { bin: provBin })

      assert.equal(
        a.status,
        c.want,
        `tracked seed, ${c.name}: expected ${c.want}`,
      )
      assert.equal(
        a.status,
        b.status,
        `the two shims diverged on ${c.name}: tracked=${a.status} provisioned=${b.status}`,
      )
    }

    // The ONE sanctioned difference, asserted rather than left implicit so nobody "unifies" the
    // two files by deleting findPageBin: only the tracked seed resolves <repo>/bin/page.
    const trackedSrc = fs.readFileSync(tracked.coordJs, 'utf8')
    const provisionedSrc = fs.readFileSync(provisioned.coordJs, 'utf8')
    assert.ok(
      trackedSrc.includes('findPageBin'),
      'the tracked seed lost findPageBin',
    )
    assert.ok(
      !provisionedSrc.includes('findPageBin'),
      'the provisioned shim gained findPageBin - if that is deliberate, update this pin and #871',
    )
  })
})
