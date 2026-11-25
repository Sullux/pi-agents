const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DEFAULT_MODELS_PATH = path.join(
  os.homedir(),
  '.pi',
  'agent',
  'models.json',
)
const DEFAULT_QW_CONTEXT_WINDOW = 1048576

const syncModelContextOverride = ({
  modelsPath = DEFAULT_MODELS_PATH,
  model = 'qw/qwen3.8-max',
  contextWindow,
  fsImpl = fs,
} = {}) => {
  try {
    const slashIdx = String(model || '').indexOf('/')
    if (slashIdx <= 0) return { ok: true, changed: false }
    const provider = model.slice(0, slashIdx)
    const modelId = model.slice(slashIdx + 1)
    if (!modelId) return { ok: true, changed: false }

    const explicitWindow = Number(contextWindow)
    const hasExplicit = Number.isFinite(explicitWindow) && explicitWindow > 0
    if (provider !== 'qw' && !hasExplicit) return { ok: true, changed: false }

    let config = { $schema: 'https://pi.dev/schemas/models.schema.json' }
    if (fsImpl.existsSync(modelsPath)) {
      const raw = fsImpl.readFileSync(modelsPath, 'utf8')
      config = JSON.parse(raw || '{}')
    }

    const providers = config.providers || {}
    const providerCfg = providers[provider] || {}
    const overrides = providerCfg.modelOverrides || {}
    const current = overrides[modelId] || {}
    const targetWindow = hasExplicit
      ? explicitWindow
      : DEFAULT_QW_CONTEXT_WINDOW

    if (current.contextWindow === targetWindow) {
      return { ok: true, changed: false, contextWindow: current.contextWindow }
    }

    overrides[modelId] = { ...current, contextWindow: targetWindow }
    providerCfg.modelOverrides = overrides
    providers[provider] = providerCfg
    config.providers = providers

    fsImpl.writeFileSync(modelsPath, JSON.stringify(config, null, 2), 'utf8')
    return { ok: true, changed: true, contextWindow: targetWindow }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

module.exports = {
  DEFAULT_QW_CONTEXT_WINDOW,
  syncModelContextOverride,
}
