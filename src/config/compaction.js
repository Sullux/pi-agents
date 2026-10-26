const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DEFAULT_SETTINGS_PATH = path.join(
  os.homedir(),
  '.pi',
  'agent',
  'settings.json',
)

const syncCompactionSettings = ({
  settingsPath = DEFAULT_SETTINGS_PATH,
  model = 'qw/qwen3.8-max',
  contextWindow = 262144,
  percent = 60,
  fsImpl = fs,
} = {}) => {
  try {
    let settings = {}
    if (fsImpl.existsSync(settingsPath)) {
      const content = fsImpl.readFileSync(settingsPath, 'utf8')
      settings = JSON.parse(content || '{}')
    }

    const safePercent = Math.min(Math.max(Number(percent) || 60, 10), 95)
    const reserveTokens = Math.max(
      16384,
      Math.round(contextWindow * (1 - safePercent / 100)),
    )

    const compaction = settings.compaction || {}
    compaction.enabled = true
    compaction.keepRecentTokens = compaction.keepRecentTokens || 20000

    const modelOverrides = compaction.modelOverrides || {}
    modelOverrides[model] = {
      reserveTokens,
      keepRecentTokens: 20000,
    }

    compaction.modelOverrides = modelOverrides
    settings.compaction = compaction

    fsImpl.writeFileSync(
      settingsPath,
      JSON.stringify(settings, null, 2),
      'utf8',
    )
    return { ok: true, reserveTokens, percent: safePercent }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

module.exports = {
  syncCompactionSettings,
}
