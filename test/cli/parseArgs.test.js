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

describe('#28 a valueless flag cannot swallow the positional after it', () => {
  it('--force keeps the message as a positional', () => {
    const parsed = parseArgs(['done', '21', '--force', 'attested'])
    assert.equal(
      parsed.flags.force,
      true,
      'the flag is a boolean, not a string',
    )
    assert.deepEqual(
      parsed.positionals,
      ['21', 'attested'],
      'the attestation text survives - before the fix it landed in flags.force and the DONE ' +
        'comment went out header-only, silently dropping the message',
    )
  })

  it('--kill behaves the same, and it is documented as a switch', () => {
    const parsed = parseArgs(['stop', 'alpha', '--kill'])
    assert.equal(parsed.flags.kill, true)
    assert.deepEqual(parsed.positionals, ['alpha'])
  })

  it('control: a flag that DOES take a value is still greedy, so the fix is targeted', () => {
    const parsed = parseArgs(['done', '21', '--pr', '9', 'attested'])
    assert.equal(parsed.flags.pr, '9', '--pr must keep consuming its number')
    assert.deepEqual(parsed.positionals, ['21', 'attested'])
    assert.equal(
      parsed.flags.attested,
      undefined,
      'and nothing leaked into a flag',
    )
  })

  it('--force=... keeps the explicit-value form working', () => {
    const parsed = parseArgs(['done', '21', '--force=true', 'note'])
    assert.equal(parsed.flags.force, 'true')
    assert.deepEqual(parsed.positionals, ['21', 'note'])
  })
})
