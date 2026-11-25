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

  it('defaults non-qw models to 262144 context and 60% compaction when omitted', () => {
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
      model: 'google/gemini-3.8-flash',
      fsImpl: mockFs,
    })

    assert.equal(res.ok, true)
    assert.equal(res.percent, 60)
    assert.equal(res.reserveTokens, 104858)
    const parsed = JSON.parse(savedContent)
    assert.equal(parsed.compaction.enabled, true)
  })

  it('defaults qw/* models to 1M (1048576) context and 20% compaction when omitted', () => {
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
      model: 'qw/qwen4-max',
      fsImpl: mockFs,
    })

    assert.equal(res.ok, true)
    assert.equal(res.percent, 20)
    assert.equal(res.reserveTokens, 838861)
    const parsed = JSON.parse(savedContent)
    assert.equal(parsed.compaction.enabled, true)
    assert.equal(
      parsed.compaction.modelOverrides['qw/qwen4-max'].reserveTokens,
      838861,
    )
  })
})

describe('Model Context Override Synchronizer', () => {
  it('adds default 1048576 (1M) contextWindow override for missing qw/* models', () => {
    let savedContent = ''
    const mockFs = {
      existsSync: () => true,
      readFileSync: () =>
        JSON.stringify({
          $schema: 'https://pi.dev/schemas/models.schema.json',
          providers: {
            qw: {
              modelOverrides: {
                'qwen3.8-max': { contextWindow: 1048576 },
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
      model: 'qw/qwen4-max',
      fsImpl: mockFs,
    })

    assert.equal(res.ok, true)
    assert.equal(res.changed, true)
    assert.equal(res.contextWindow, 1048576)

    const parsed = JSON.parse(savedContent)
    assert.equal(
      parsed.providers.qw.modelOverrides['qwen3.8-max'].contextWindow,
      1048576,
    )
    assert.equal(
      parsed.providers.qw.modelOverrides['qwen4-max'].contextWindow,
      1048576,
    )
  })

  it('updates stale qw/* contextWindow entries to the new 1048576 default', () => {
    let savedContent = ''
    const mockFs = {
      existsSync: () => true,
      readFileSync: () =>
        JSON.stringify({
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
      model: 'qw/qwen3.8-max',
      fsImpl: mockFs,
    })

    assert.equal(res.ok, true)
    assert.equal(res.changed, true)
    assert.equal(res.contextWindow, 1048576)
    const parsed = JSON.parse(savedContent)
    assert.equal(
      parsed.providers.qw.modelOverrides['qwen3.8-max'].contextWindow,
      1048576,
    )
  })

  it('skips write if override already matches the target contextWindow', () => {
    let wrote = false
    const mockFs = {
      existsSync: () => true,
      readFileSync: () =>
        JSON.stringify({
          providers: {
            qw: {
              modelOverrides: {
                'qwen4-max': { contextWindow: 1048576 },
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
      model: 'qw/qwen4-max',
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
