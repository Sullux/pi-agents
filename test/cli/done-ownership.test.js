const { test } = require('node:test')
const assert = require('node:assert')

// pi-agents #28, CLI side. The service arms in test/coord/commands.test.js prove the fold and the
// zero-write contract; these prove the three things a caller actually touches: the refusal exits
// nonzero and says why, the documented arity mentions the override, and a bypassed guard leaves a
// visible trace in the operator's own output. On the shared @Sullux account nothing else attributes
// a close, so --force without a printed note would be an unlogged step onto a peer's work.
const { Cli } = require('../../src/cli')
const { CoordService } = require('../../src/coord')
const { USAGE } = require('../../src/coord/issueNumber')

// The CLAIM comment is built from the SAME identity the service is constructed with, never from
// the agent the CLI resolved out of the ambient COORD_AGENT. The first version interpolated
// `resolved`, which made "the caller holds this issue" a property of whoever ran the suite
// (agent-echo's #43 review: 5/5 under agent-Delta, 4/5 under agent-Echo, agent-Bravo, and CI with
// no COORD_AGENT at all). The last arm in this file pins that seam, so the dependency cannot creep
// back in through a fixture that looks self-contained.
const world = ({ comments, onWrite, agent = 'agent-delta' }) => {
  const out = []
  const err = []
  const cli = Cli({
    github: { repo: 'Sullux/pi-agents' },
    coordFactory: () =>
      CoordService({
        github: {
          viewIssue: async (number) => ({
            number,
            title: '#28 fixture',
            body: '## Files\nsrc/x.js',
            labels: [{ name: 'status:claimed' }],
            comments: comments ?? [
              { body: `**CLAIM** | agent: ${agent} | at: 1700000000000` },
            ],
          }),
          listIssues: async () => [],
          commentIssue: async () => {
            onWrite?.('comment')
            return { html_url: 'https://example.test/c' }
          },
          editIssue: async () => {
            onWrite?.('edit')
            return {}
          },
          closeIssue: async () => {
            onWrite?.('close')
            return {}
          },
        },
        agent,
        now: () => 1750000000000,
      }),
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  })
  return { out, err, run: (argv) => cli.run(argv) }
}

const echoHoldsIt = [
  {
    body: '**CLAIM** | agent: agent-echo | at: 1700000000000',
    createdAt: '2023-11-14T22:13:20.000Z',
  },
]

test('the usage string and the printed help both name --force (box 3)', async () => {
  assert.match(
    USAGE.done,
    /\[--force\]/,
    'USAGE is the table the error messages quote',
  )
  // the arity contract must keep the shape the sibling PR #37 pins, so the new flag goes at the END
  assert.match(
    USAGE.done,
    /\[--pr <n>\] \[message\]/,
    'no positional may be optional before another',
  )
  const h = world({})
  await h.run(['coord', '--help'])
  assert.match(
    h.out[0],
    /coord done .*--force/,
    'the help text names the override',
  )
})

test('the help documents that review is expected from a non-owner (box 4)', async () => {
  const h = world({})
  await h.run(['coord', '--help'])
  const help = h.out[0] || ''
  assert.match(
    help,
    /coord review /,
    'review must be in the verb list, not only in the arity table',
  )
  assert.match(
    help,
    /coord review[^\n]*non-owner/i,
    'the deliberate absence of an ownership check has to be written down somewhere a caller reads',
  )
})

test('a refusal exits nonzero, names the reason, and writes nothing', async () => {
  const writes = []
  const h = world({ comments: echoHoldsIt, onWrite: (w) => writes.push(w) })
  const status = await h.run(['coord', 'done', '21', 'my work is finished'])
  assert.notEqual(status, 0, 'box 1: the CLI exits nonzero on a refusal')
  // multi-line on purpose: a one-line grep of `deepEqual(writes` reports a false absence here
  // (agent-echo tripped on exactly that while auditing this arm)
  assert.deepEqual(
    writes,
    [],
    'and nothing reached the board - pitcairn #1104 commented, re-labeled and closed',
  )
  assert.equal(
    h.out.filter((l) => l.includes('Marked #21 done')).length,
    0,
    'a success line beside a refusal is the bug, not the message',
  )
  // the CLI writes its provenance note to stderr too, so the claim is about the ERROR line
  const errors = h.err.filter((l) => l.startsWith('Error:'))
  assert.equal(
    errors.length,
    1,
    `expected one error line, got: ${h.err.join(' | ')}`,
  )
  assert.match(errors[0], /Error: #21 is held by agent-echo/, 'names the owner')
  assert.match(
    errors[0],
    /2023-11-14T22:13:20\.000Z/,
    'names the CLAIM timestamp (box 1)',
  )
  assert.match(errors[0], /--force/, 'names the way through')
})

test('--force reaches the service and the bypass is printed (box 3)', async () => {
  const received = []
  const out = []
  const cli = Cli({
    github: { repo: 'Sullux/pi-agents' },
    coordFactory: () => ({
      done: async (number, opts) => {
        received.push(opts)
        return { ok: true, number, owner: 'echo', forced: opts.force === true }
      },
    }),
    stdout: (line) => out.push(line),
    stderr: () => {},
  })
  const status = await cli.run([
    'coord',
    'done',
    '21',
    '--force',
    'supervisor sweep',
  ])
  assert.equal(status, 0)
  assert.equal(received.length, 1, 'the CLI called done exactly once')
  assert.equal(
    received[0].force,
    true,
    'flags.force must be threaded, not parsed and dropped',
  )
  assert.equal(
    received[0].text,
    'supervisor sweep',
    'and the message still rides along',
  )
  assert.match(
    out.join('\n'),
    /--force used: the ownership check was bypassed on #21 \(held by agent-echo\)/,
    `expected a logged override, got: ${out.join(' | ')}`,
  )
})

test('a routine self-close stays one line, and success keeps its shape', async () => {
  const writes = []
  const h = world({ onWrite: (w) => writes.push(w) })
  const status = await h.run(['coord', 'done', '21', 'attested'])
  assert.equal(
    status,
    0,
    `a held-by-me issue must still close: ${h.err.join(' | ')}`,
  )
  assert.deepEqual(
    writes,
    ['comment', 'edit', 'close'],
    'the full close-out still lands',
  )
  const marked = h.out.filter((l) => l.startsWith('Marked #21 done'))
  assert.equal(marked.length, 1)
  assert.ok(
    marked[0].endsWith('@Sullux/pi-agents'),
    '#23: the target stays the last token even with the new note line available',
  )
  assert.equal(
    h.out.filter((l) => l.includes('--force used')).length,
    0,
    'no note when nothing was bypassed, or the warning becomes wallpaper',
  )
})

test('the double does not read the ambient COORD_AGENT (the #43 review blocker, pinned)', async () => {
  // a foreign identity in the environment must not be able to redden a self-owned close-out - that
  // is what made the first version of this file pass for one agent and fail for the rest of the fleet
  const previous = process.env.COORD_AGENT
  const writes = []
  try {
    process.env.COORD_AGENT = 'agent-somebody-else'
    const h = world({ onWrite: (w) => writes.push(w) })
    const status = await h.run(['coord', 'done', '21', 'attested'])
    assert.equal(
      status,
      0,
      `the close must not depend on the ambient identity: ${h.err.join(' | ')}`,
    )
    assert.deepEqual(writes, ['comment', 'edit', 'close'])
  } finally {
    if (previous === undefined) delete process.env.COORD_AGENT
    else process.env.COORD_AGENT = previous
  }
})
