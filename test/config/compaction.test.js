const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { syncCompactionSettings } = require('../../src/config/compaction')

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
