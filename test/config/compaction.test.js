const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { syncCompactionSettings } = require('../../src/config/compaction')
const { syncModelContextOverride } = require('../../src/config/modelOverride')

describe('Compaction Settings Synchronizer', () => {
  it('creates compaction settings with proper reserveTokens for model', () => {
    let savedContent = ''
    const mockFs = {
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ defaultModel: 'qw/qwen3.8-max' }),
      writeFileSync: (_path, data) => {
        savedContent = data
      },
    }

    const res = syncCompactionSettings({
      settingsPath: '/fake/settings.json',
      model: 'qw/qwen3.8-max',
      contextWindow: 262144,
      percent: 70,
      fsImpl: mockFs,
    })

    assert.equal(res.ok, true)
    assert.equal(res.percent, 70)
    assert.equal(res.reserveTokens, 78643)

    const parsed = JSON.parse(savedContent)
    assert.equal(parsed.compaction.enabled, true)
    assert.equal(
      parsed.compaction.modelOverrides['qw/qwen3.8-max'].reserveTokens,
      78643,
    )
  })

  it('handles non-existent settings file gracefully', () => {
    let savedContent = ''
    const mockFs = {
      existsSync: () => false,
      readFileSync: () => '',
      writeFileSync: (_path, data) => {
        savedContent = data
      },
    }

    const res = syncCompactionSettings({
      settingsPath: '/fake/missing.json',
      model: 'qw/qwen3.8-max',
      contextWindow: 262144,
      percent: 60,
      fsImpl: mockFs,
    })

    assert.equal(res.ok, true)
    assert.equal(res.reserveTokens, 104858)
    const parsed = JSON.parse(savedContent)
    assert.equal(parsed.compaction.enabled, true)
  })
})

describe('Model Context Override Synchronizer', () => {
  it('adds default 262144 contextWindow override for missing qw/* models', () => {
    let savedContent = ''
    const mockFs = {
      existsSync: () => true,
      readFileSync: () =>
        JSON.stringify({
          $schema: 'https://pi.dev/schemas/models.schema.json',
          providers: {
            qw: {
              modelOverrides: {
                'qwen3.8-max': { contextWindow: 262144 },
              },
            },
          },
        }),
      writeFileSync: (_path, data) => {
        savedContent = data
      },
    }

    const res = syncModelContextOverride({
      modelsPath: '/fake/models.json',
      model: 'qw/qwen4-max-preview',
      fsImpl: mockFs,
    })

    assert.equal(res.ok, true)
    assert.equal(res.changed, true)
    assert.equal(res.contextWindow, 262144)

    const parsed = JSON.parse(savedContent)
    assert.equal(
      parsed.providers.qw.modelOverrides['qwen3.8-max'].contextWindow,
      262144,
    )
    assert.equal(
      parsed.providers.qw.modelOverrides['qwen4-max-preview'].contextWindow,
      262144,
    )
  })

  it('skips write if override already exists and no explicit override was passed', () => {
    let wrote = false
    const mockFs = {
      existsSync: () => true,
      readFileSync: () =>
        JSON.stringify({
          providers: {
            qw: {
              modelOverrides: {
                'qwen4-max-preview': { contextWindow: 262144 },
              },
            },
          },
        }),
      writeFileSync: () => {
        wrote = true
      },
    }

    const res = syncModelContextOverride({
      modelsPath: '/fake/models.json',
      model: 'qw/qwen4-max-preview',
      fsImpl: mockFs,
    })

    assert.equal(res.ok, true)
    assert.equal(res.changed, false)
    assert.equal(wrote, false)
  })

  it('does not touch non-qw models unless an explicit contextWindow is given', () => {
    let wrote = false
    const mockFs = {
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ providers: {} }),
      writeFileSync: () => {
        wrote = true
      },
    }

    const res = syncModelContextOverride({
      modelsPath: '/fake/models.json',
      model: 'google/gemini-3.8-flash',
      fsImpl: mockFs,
    })

    assert.equal(res.ok, true)
    assert.equal(res.changed, false)
    assert.equal(wrote, false)
  })
})
