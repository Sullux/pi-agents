const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { parseArgs } = require('../../src/cli/parseArgs')

describe('CLI Argument Parser', () => {
  it('parses commands, positional args, and flags', () => {
    const parsed = parseArgs([
      'run',
      'alpha',
      'pitcairn-portal',
      '--model',
      'claude-3-5-sonnet',
      '--max-cycles',
      '5',
      '--verbose',
    ])

    assert.equal(parsed.command, 'run')
    assert.deepEqual(parsed.positionals, ['alpha', 'pitcairn-portal'])
    assert.equal(parsed.flags.model, 'claude-3-5-sonnet')
    assert.equal(parsed.flags['max-cycles'], '5')
    assert.equal(parsed.flags.verbose, true)
  })

  it('handles empty args and help flags', () => {
    assert.equal(parseArgs([]).command, 'help')
    assert.equal(parseArgs(['--help']).command, 'help')
    assert.equal(parseArgs(['-h']).command, 'help')
  })
})
