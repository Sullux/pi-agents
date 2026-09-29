const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Cli } = require('../../src/cli')

describe('CLI Commands', () => {
  it('handles profiles list, add, and use', async () => {
    let mockProfiles = {
      default: { path: '/mock/agents' },
    }
    let active = 'default'
    let output = []

    const mockLoader = {
      profile: {
        listProfiles: () =>
          Object.entries(mockProfiles).map(([name, data]) => ({
            name,
            ...data,
          })),
        addProfile: (name, path) => {
          mockProfiles[name] = { path }
          return { name, path }
        },
        useProfile: (name) => {
          active = name
        },
        resolveActiveProfileName: () => active,
      },
    }

    const cli = Cli({
      configLoader: mockLoader,
      stdout: (msg) => output.push(msg),
      stderr: (msg) => output.push(`ERR: ${msg}`),
    })

    // 1. List
    await cli.run(['profiles', 'list'])
    assert.ok(output[0].includes('default'))

    // 2. Add
    output = []
    await cli.run(['profiles', 'add', 'work', '/mock/work'])
    assert.ok(output[0].includes("Added profile 'work'"))
    assert.ok(mockProfiles.work)

    // 3. Use
    output = []
    await cli.run(['use', 'work'])
    assert.ok(output[0].includes("Switched active profile to 'work'"))
    assert.equal(active, 'work')
  })

  it('handles projects add with auto-generated alias', async () => {
    let saved = {}
    let output = []
    const mockLoader = {
      project: {
        save: (alias, data) => {
          saved[alias] = data
        },
      },
      agent: { list: () => [] },
      agentsRoot: '/mock/agents',
    }

    const cli = Cli({
      configLoader: mockLoader,
      stdout: (msg) => output.push(msg),
      stderr: (msg) => output.push(`ERR: ${msg}`),
    })

    await cli.run([
      'projects',
      'add',
      'Sullux/pitcairn-portal',
      '--alias',
      'pp',
    ])
    assert.ok(
      output[0].includes("Registered project 'pp' -> Sullux/pitcairn-portal"),
    )
    assert.ok(saved.pp)
    assert.equal(saved.pp.repo, 'Sullux/pitcairn-portal')
  })
})
