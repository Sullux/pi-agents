const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')
const { Cli } = require('../../src/cli')

// #19: `printHelp()` wrote to the GLOBAL `console.log`, so `Cli({ stdout, stderr })` could not see its
// own usage path. The consequence measured in #18's pin set: a test that injected sinks asserted
// `h.out` was EMPTY after an unknown verb, because that is what the sink genuinely received while 2KB
// of usage text went past it. Every arm below therefore asserts CONTENT in the injected sink, and the
// leak arm asserts the converse - the global console receives none of it. Pre-fix the leak arm is the
// one that reddens; the content arms alone would pass vacuously on a blank write, so they name
// distinctive lines rather than a non-empty check.

const UsageAnchor = 'Usage: page <command> [subcommand] [args...] [flags]'
const SectionAnchor = 'Coordination Commands:'
const VerbAnchor = 'coord board'

const harness = ({ note = () => '' } = {}) => {
  const out = []
  const err = []
  const cli = Cli({
    coordFactory: () => ({}),
    provenance: { note, describe: () => 'D' },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  })
  return { out, err, run: (argv) => cli.run(argv) }
}

const renderedUsage = (lines) =>
  assert.ok(
    lines.some((l) => l.includes(UsageAnchor)),
    `the injected sink never received the usage header (got ${JSON.stringify(lines)})`,
  )

const withGlobalCaptured = async (body) => {
  const real = console.log
  const seen = []
  console.log = (...args) => seen.push(args.join(' '))
  try {
    return { result: await body(), seen }
  } finally {
    console.log = real
  }
}

describe('Cli: the usage path honors the injected sink (#19)', () => {
  it('`page help` lands its usage text in the injected stdout and exits 0', async () => {
    const h = harness()
    assert.equal(await h.run(['help']), 0)
    assert.equal(
      h.out.length,
      1,
      'the help path wrote a different number of lines than one render',
    )
    renderedUsage(h.out)
    assert.ok(
      h.out[0].includes(SectionAnchor),
      'the Coordination Commands section is missing',
    )
    assert.ok(h.out[0].includes(VerbAnchor), 'the coord verb list is missing')
    assert.deepEqual(h.err, [], 'the help path wrote to stderr')
  })

  it('`page --help` renders the same usage into the sink and exits 0', async () => {
    const h = harness()
    assert.equal(await h.run(['--help']), 0)
    renderedUsage(h.out)
  })

  it('`page -h` takes the same path', async () => {
    const h = harness()
    assert.equal(await h.run(['-h']), 0)
    renderedUsage(h.out)
  })

  it('the unknown-verb fall-through renders usage into the sink and still exits 1', async () => {
    const note = 'coord note: #19 ADVISORY'
    const h = harness({ note: () => note })
    assert.equal(
      await h.run(['coord', 'frobnicate']),
      1,
      'the unknown verb changed its exit code',
    )
    // the advisory stays on stderr: threading the sink must not have moved it onto stdout
    assert.deepEqual(h.err, [note])
    renderedUsage(h.out)
  })

  it('neither usage render touches the global console (the defect itself)', async () => {
    for (const argv of [['help'], ['--help'], ['coord', 'frobnicate']]) {
      const h = harness()
      // filtered to the anchor rather than "console.log was called", because the test reporter writes
      // through the same global and an unfiltered assert would measure the harness, not the program
      const { result, seen } = await withGlobalCaptured(() => h.run(argv))
      const leaked = seen.filter((line) => line.includes(UsageAnchor))
      assert.deepEqual(
        leaked,
        [],
        `${JSON.stringify(argv)} wrote usage text to the global console`,
      )
      assert.ok(
        h.out.some((l) => l.includes(UsageAnchor)),
        `${JSON.stringify(argv)} exited ${result} without rendering usage into the injected sink`,
      )
    }
  })

  it('the real binary with no injected sinks still prints usage to stdout', () => {
    const root = join(__dirname, '..', '..')
    const text = execFileSync(
      process.execPath,
      [join(root, 'bin', 'page'), 'help'],
      {
        cwd: root,
        encoding: 'utf8',
      },
    )
    // this is the arm that keeps the default (`sink = console.log`) honest: threading stdout through
    // `Cli` must not break the un-injected path an agent actually runs
    assert.ok(
      text.includes(UsageAnchor),
      'the shipped binary stopped printing its usage',
    )
    assert.ok(
      text.includes(SectionAnchor),
      'the shipped binary lost the coord section',
    )
  })
})
