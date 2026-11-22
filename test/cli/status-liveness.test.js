const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { Cli } = require('../../src/cli')
const { LIVENESS } = require('../../src/runner/liveness')

// #166 box 1: drive the REAL status renderer with sessions in all three liveness states and assert the
// three distinct strings are RENDERED in the output columns - not merely present in a payload. behind is
// injected per pid so wedged is produced by the conjunction (behind + streak), the same path production uses.
const harness = (sessions, behindByPid) => {
  const out = []
  const cli = Cli({
    sessionTracker: { listSessions: () => sessions },
    runnerCurrency: { behindOf: (pid) => behindByPid[pid] ?? 0 },
    // #170's runtime-identity footer embeds the CHECKOUT PATH, which in the fleet contains an agent
    // name (.../agents/Bravo/...). Inject it deterministically so the name-collision class is
    // reproduced in EVERY checkout, not only ones whose path happens to carry a session's name.
    runtimeIdentity: () => ({
      path: '/home/charles/agents/Bravo/pi-166/bin/page',
      commit: 'f45202dfe',
    }),
    stdout: (l) => out.push(...String(l).split('\n')),
    stderr: () => {},
  })
  return { out, run: (argv) => cli.run(argv) }
}

const session = (pid, agent, waveState, advisoryStreak) => ({
  pid,
  agent,
  project: 'pp',
  status: 'running',
  startedAt: Date.now() - 60000,
  waveState,
  advisoryStreak,
})

describe('#166 status renders the liveness column', () => {
  test('all three states render as distinct strings through the real renderer', async () => {
    const h = harness(
      [
        session(101, 'Alpha', 'idle', 0),
        session(102, 'Bravo', 'in-wave', 0),
        session(103, 'Charlie', 'idle', 2),
      ],
      { 101: 0, 102: 0, 103: 15 },
    )
    const code = await h.run(['status'])
    assert.equal(code, 0)
    const text = h.out.join('\n')
    assert.match(text, /LIVENESS/, 'the column header is rendered')
    const rowOf = (agent) => h.out.find((l) => l.includes(agent))
    assert.match(rowOf('Alpha'), /\bidle\b/)
    assert.match(rowOf('Bravo'), /\bin-wave\b/)
    assert.match(rowOf('Charlie'), /\bwedged\b/)
  })

  test('the rendered vocabulary is exactly the shared set (no blank, no fall-through to running)', async () => {
    const h = harness(
      [
        session(201, 'Alpha', 'idle', 0),
        session(202, 'Bravo', 'in-wave', 0),
        session(203, 'Charlie', 'idle', 3),
      ],
      { 203: 9 },
    )
    await h.run(['status'])
    const rendered = h.out
      // Anchor at line START: session rows begin with the AGENT column; #170's `runtime:` footer
      // can contain an agent name inside its path and must not read as a fourth session row.
      .filter((l) => /^(Alpha|Bravo|Charlie)\s/.test(l))
      .map((l) => LIVENESS.find((s) => new RegExp(`\\b${s}\\b`).test(l)))
    assert.deepEqual([...new Set(rendered)].sort(), [...LIVENESS].sort())
  })

  test('a stale-but-live runner renders idle, not wedged (the duplicate is the discrimination)', async () => {
    const h = harness([session(301, 'Delta', 'idle', 1)], { 301: 15 })
    await h.run(['status'])
    const row = h.out.find((l) => l.includes('Delta'))
    assert.match(row, /\bidle\b/)
    assert.doesNotMatch(row, /wedged/)
  })
})
