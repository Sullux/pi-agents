const path = require('node:path')
const os = require('node:os')

// #865: the seed SKILL.md is machine-independent, so the one path that IS derivable
// from the provisioning target is written as a token and resolved at copy time.
const SKILL_DIR_TOKEN = '{{COORD_SKILL_DIR}}'

// #865: the shim a freshly provisioned workspace gets. It used to be a 3-line spawn
// whose exit status was dropped, so a REFUSED claim, a scope collision or a typo'd
// verb all read as success to anything gating on $? - the hazard #816 closed for the
// fleet's installed copy, which a new workspace never received. Kept byte-identical
// to that installed copy so there is one shim behaviour, not two.
const COORD_JS_SHIM = [
  '#!/usr/bin/env node',
  "// #816: this shim is the fleet's documented entry point, and it used to swallow the exit status -",
  '// `page coord <unknown verb>` exits 1, but every call through here exited 0. Any script gating on',
  '// `$?` (claim && start-work, a CI step, a `set -e` wrapper) therefore treated a REFUSED claim, a',
  "// scope collision or a typo'd verb as success. Propagate the real status; `?? 1` covers a",
  '// signal-kill, where spawnSync reports status null.',
  "const { spawnSync } = require('node:child_process')",
  '',
  "const result = spawnSync('page', ['coord', ...process.argv.slice(2)], {",
  "  stdio: 'inherit',",
  '  env: process.env,',
  '})',
  '',
  'if (result.error) {',
  '  console.error(`coord: cannot run \\`page coord\\`: ${result.error.message}`)',
  '  process.exit(1)',
  '}',
  '',
  'process.exit(result.status ?? 1)',
  '',
].join('\n')

const ProfileManager = ({
  fs = require('node:fs'),
  homeDir = os.homedir(),
} = {}) => {
  const configDir = path.join(homeDir, '.config', 'page')
  const profilesPath = path.join(configDir, 'profiles.json')
  const configPath = path.join(configDir, 'config.json')

  const loadConfig = () => {
    if (!fs.existsSync || !fs.existsSync(configPath)) return {}
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'))
    } catch {
      return {}
    }
  }

  const saveConfig = (cfg) => {
    if (fs.mkdirSync) fs.mkdirSync(configDir, { recursive: true })
    if (fs.writeFileSync)
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2))
  }

  const loadProfiles = () => {
    if (!fs.existsSync || !fs.existsSync(profilesPath)) return {}
    try {
      return JSON.parse(fs.readFileSync(profilesPath, 'utf8'))
    } catch {
      return {}
    }
  }

  const saveProfiles = (data) => {
    if (fs.mkdirSync) fs.mkdirSync(configDir, { recursive: true })
    if (fs.writeFileSync)
      fs.writeFileSync(profilesPath, JSON.stringify(data, null, 2))
  }

  const ensureProfileStructure = (
    targetPath,
    name = 'default',
    options = {},
  ) => {
    const pageDir = path.join(targetPath, '.page')
    const skillScriptsDir = path.join(
      targetPath,
      '.agents',
      'skills',
      'coordinate',
      'scripts',
    )

    if (fs.mkdirSync) {
      fs.mkdirSync(pageDir, { recursive: true })
      fs.mkdirSync(skillScriptsDir, { recursive: true })
    }

    const profileJsonPath = path.join(pageDir, 'profile.json')
    if (fs.existsSync && !fs.existsSync(profileJsonPath) && fs.writeFileSync) {
      const defaultProfileData = {
        name,
        defaultModel:
          options.defaultModel || 'anthropic:claude-3-5-sonnet-latest',
        defaultThinking: options.defaultThinking || 'low',
      }
      fs.writeFileSync(
        profileJsonPath,
        JSON.stringify(defaultProfileData, null, 2),
      )
    }

    const profileEnvPath = path.join(pageDir, 'profile.env')
    if (fs.existsSync && !fs.existsSync(profileEnvPath) && fs.writeFileSync) {
      fs.writeFileSync(
        profileEnvPath,
        '# Profile-level secrets and environment overrides\n',
      )
    }

    const skillRoot = path.join(targetPath, '.agents', 'skills', 'coordinate')
    const sourceSkillRoot = path.resolve(
      __dirname,
      '../../.agents/skills/coordinate',
    )
    const skillMdPath = path.join(skillRoot, 'SKILL.md')
    if (fs.existsSync && !fs.existsSync(skillMdPath) && fs.writeFileSync) {
      const sourceSkill = path.join(sourceSkillRoot, 'SKILL.md')
      if (fs.existsSync(sourceSkill) && fs.readFileSync) {
        // #865: resolve the seed's one derivable path to THIS workspace. It stays
        // absolute because #816 measured the relative form failing from inside a
        // project worktree; split/join rather than replaceAll so a partial-mock fs
        // and older runtimes behave identically.
        const seed = fs.readFileSync(sourceSkill, 'utf8')
        fs.writeFileSync(
          skillMdPath,
          seed.split(SKILL_DIR_TOKEN).join(skillRoot),
        )
      }
    }

    // #865: SKILL.md links ./references/*.md for the start-of-session playbook and
    // the verb/tie-break spec. Provisioning copied SKILL.md alone, so a fresh
    // workspace was told to read two files that did not exist. Same copy-only-when-
    // absent rule as every other file here, so a workspace's own edits survive.
    const sourceRefsRoot = path.join(sourceSkillRoot, 'references')
    const refsRoot = path.join(skillRoot, 'references')
    if (
      fs.existsSync &&
      fs.existsSync(sourceRefsRoot) &&
      fs.readdirSync &&
      fs.mkdirSync &&
      fs.writeFileSync &&
      fs.readFileSync
    ) {
      fs.mkdirSync(refsRoot, { recursive: true })
      for (const entry of fs.readdirSync(sourceRefsRoot)) {
        const source = path.join(sourceRefsRoot, entry)
        const target = path.join(refsRoot, entry)
        const isFile = fs.statSync ? fs.statSync(source).isFile() : true
        if (isFile && !fs.existsSync(target)) {
          fs.writeFileSync(target, fs.readFileSync(source, 'utf8'))
        }
      }
    }

    const coordJsPath = path.join(skillScriptsDir, 'coord.js')
    if (fs.existsSync && !fs.existsSync(coordJsPath) && fs.writeFileSync) {
      fs.writeFileSync(coordJsPath, COORD_JS_SHIM)
      if (fs.chmodSync) fs.chmodSync(coordJsPath, 0o755)
    }

    const coordShPath = path.join(skillScriptsDir, 'coord.sh')
    if (fs.existsSync && !fs.existsSync(coordShPath) && fs.writeFileSync) {
      fs.writeFileSync(
        coordShPath,
        `#!/usr/bin/env bash\nexec node "$(dirname "$0")/coord.js" "$@"\n`,
      )
      if (fs.chmodSync) fs.chmodSync(coordShPath, 0o755)
    }
  }

  const resolveActiveProfileName = (flags = {}, env = process.env) => {
    if (flags.profile || flags.p) return flags.profile || flags.p
    if (env.PAGE_PROFILE) return env.PAGE_PROFILE
    const cfg = loadConfig()
    if (cfg.activeProfile) return cfg.activeProfile
    return 'default'
  }

  const listProfiles = () => {
    const profiles = loadProfiles()
    return Object.entries(profiles).map(([name, data]) => ({
      name,
      ...data,
    }))
  }

  const getProfile = (name) => {
    const profiles = loadProfiles()
    if (!profiles[name]) return undefined
    ensureProfileStructure(profiles[name].path, name)
    return { name, ...profiles[name] }
  }

  const addProfile = (name, targetPath, options = {}) => {
    const resolvedPath = path.resolve(targetPath.replace(/^~/, homeDir))
    ensureProfileStructure(resolvedPath, name, options)

    const profiles = loadProfiles()
    profiles[name] = {
      path: resolvedPath,
      createdAt: Date.now(),
    }
    saveProfiles(profiles)

    const cfg = loadConfig()
    if (!cfg.activeProfile || options.use) {
      cfg.activeProfile = name
      saveConfig(cfg)
    }

    return { name, path: resolvedPath, ...profiles[name] }
  }

  const removeProfile = (name) => {
    const profiles = loadProfiles()
    if (!profiles[name]) return false
    delete profiles[name]
    saveProfiles(profiles)
    return true
  }

  const useProfile = (name) => {
    const cfg = loadConfig()
    cfg.activeProfile = name
    saveConfig(cfg)
    return name
  }

  return {
    listProfiles,
    getProfile,
    addProfile,
    removeProfile,
    resolveActiveProfileName,
    useProfile,
    ensureProfileStructure,
  }
}

module.exports = {
  ProfileManager,
}
