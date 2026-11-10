// pi-agents#52. `claim` posts a **CLAIM** line and calls it done when the POST succeeds, but the
// half of the tool that decides ownership is `ownerOf` reading the timeline BACK. Measured shapes
// where the two disagree, every one of them a silent success today: an identity that cannot round-
// trip (an agent value with a pipe truncates at the delimiter, so the board names a different
// agent); a rival protocol line landing after mine inside one refresh; and a refresh that does not
// contain the line just written (an empty COORD_AGENT writes `agent: agent-`, which ownerOf answers
// "nobody" for while claim reports success because both sides of its own comparison were empty).
// The remedy is branched per cause, so each arm asserts its OWN remedy and the absence of the
// others: a wrong remedy on a shared board is worse than none (re-posting a line a rival already
// overwrote re-arms a race; standing down from your own truncation abandons work you hold).
//
// World: a `gh` that KEEPS A TIMELINE. The old doubles pushed bodies to a side array and handed back
// `comments: []`, which is why three of them had to be completed for this contract to be testable.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { CoordService } = require('../../src/coord')

const repoRoot = join(__dirname, '..', '..')

const RIVAL = '**CLAIM** | agent: agent-bravo | human: @Sullux | at: 1'

const STUB = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const dir = process.env.SHIM_DIR
const args = process.argv.slice(2)
const joined = args.join(' ')
fs.appendFileSync(path.join(dir, 'calls.log'), joined + '\\n')
const posted = () =>
  fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('c-'))
    .sort()
    .map((f) => ({
      id: f,
      createdAt: '2030-06-06T00:00:00Z',
      body: fs.readFileSync(path.join(dir, f), 'utf8'),
    }))
// A rival appears ONLY once my own line exists: staged before the write it trips the pre-claim
// owner check and the code under test never runs, which is the difference between pinning the
// race and pinning a fixture.
const timeline = () => {
  const tl = posted()
  if (process.env.SHIM_MODE === 'drop') return []
  if (process.env.SHIM_RIVAL && tl.length) {
    const at = process.env.SHIM_RIVAL === 'earlier' ? '2001-01-01T00:00:00Z' : '2099-01-01T00:00:00Z'
    tl[process.env.SHIM_RIVAL === 'earlier' ? 'unshift' : 'push']({ id: 'r', createdAt: at, body: ${JSON.stringify(RIVAL)} })
  }
  return tl
}
if (joined.startsWith('api ')) {
  console.log(JSON.stringify({ isPullRequest: false, title: '#52 stub fixture', body: '## Files\\nsrc/foo.js' }))
} else if (joined.startsWith('issue comment')) {
  fs.writeFileSync(path.join(dir, 'c-' + String(posted().length).padStart(3, '0')), args[args.indexOf('--body') + 1])
  console.log('{}')
} else if (joined.startsWith('issue view')) {
  console.log(JSON.stringify({ number: 999999, title: '#52 stub fixture', body: '## Files\\nsrc/foo.js', labels: [], comments: timeline() }))
} else if (joined.startsWith('issue list')) {
  console.log('[]')
} else {
  console.log('{}')
}
`

const world = ({ mode = 'echo', rival = '', agent = 'pi/tester' } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'pi52-'))
  writeFileSync(join(dir, 'gh'), STUB)
  chmodSync(join(dir, 'gh'), 0o755)
  const calls = () =>
    readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean)
  const count = (prefix) => calls().filter((c) => c.startsWith(prefix)).length
  const run = (args) => {
    rmSync(join(dir, 'calls.log'), { force: true })
    for (const f of readdirSync(dir).filter((x) => x.startsWith('c-')))
      rmSync(join(dir, f))
    return spawnSync(
      process.execPath,
      [join(repoRoot, 'bin', 'page'), ...args],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          SHIM_DIR: dir,
          SHIM_MODE: mode,
          SHIM_RIVAL: rival,
          COORD_REPO: 'Sullux/pi-agents-fake',
          COORD_AGENT: agent,
        },
      },
    )
  }
  return {
    run,
    calls,
    count,
    done: () => rmSync(dir, { recursive: true, force: true }),
  }
}

describe('#52 claim attests that its own CLAIM line resolves', () => {
  it('the happy path still claims, and the self-check TRAVELED (two views: the gate, then the attestation)', () => {
    const w = world()
    const res = w.run(['coord', 'claim', '999999', '--plan', 'docs'])
    assert.equal(res.status, 0, `want success, got: ${res.stderr}`)
    assert.match(res.stdout, /Claimed #999999/)
    assert.equal(
      w.count('issue comment'),
      1,
      'exactly the CLAIM line was written',
    )
    assert.equal(
      w.count('issue view'),
      2,
      'the pre-claim read and the post-write attestation read',
    )
    w.done()
  })

  it('an identity that does not round-trip is refused BEFORE the write, not reported as a lost race', () => {
    // Measured before this guard existed: COORD_AGENT='pi/a|b' cleaned to 'a|b', the posted field
    // parsed back as 'a', and evaluateClaimRace read that as a RIVAL - `Error: Lost simultaneous
    // claim race to a`, i.e. losing a race to your own truncated name, AFTER the write had landed.
    const w = world({ agent: 'pi/a|b' })
    const res = w.run(['coord', 'claim', '999999'])
    assert.equal(res.status, 1)
    assert.match(res.stderr, /does not round-trip/)
    assert.match(res.stderr, /nothing was written/)
    assert.doesNotMatch(
      res.stderr,
      /Lost simultaneous claim race/,
      'the race must not be told my own line is a rival',
    )
    assert.equal(
      w.count('issue comment'),
      0,
      'proven by spawn count, not by the exit code',
    )
    assert.equal(w.count('issue edit'), 0, 'and no label either')
    w.done()
  })

  it('an empty identity is refused at the service edge, where it is constructible', async () => {
    // The CLI cannot express it: `process.env.COORD_AGENT || 'agent-cli'` (src/cli/index.js) folds
    // an empty value into a working fallback - which is why the arm above uses a pipe. The factory
    // is the edge where '' actually arrives, and there it writes nothing.
    const posted = []
    const coord = CoordService({
      github: {
        issueKind: async () => ({ isPullRequest: false }),
        viewIssue: async () => ({
          number: 7,
          body: '## Files\nsrc/foo.js',
          labels: [],
          comments: [],
        }),
        listIssues: async () => [],
        commentIssue: async (num, body) => posted.push(body),
        editIssue: async () => {},
      },
      agent: '',
      now: () => 1700000000000,
    })
    const res = await coord.claim(7)
    assert.equal(
      res.ok,
      false,
      'an owner nobody can name must not report success',
    )
    assert.match(res.error, /does not round-trip/)
    assert.deepEqual(posted, [], 'nothing was written')
  })

  it('#102: a rival line AFTER mine loses the race to my stamp - the claim STANDS, no stand-down prints', () => {
    // Restated from 'a rival line AFTER mine stands down', which pinned ownership-as-last-word:
    // its header comment documented the race and the fold disagreeing by design. #102 folds Rule C
    // into applyMarker (owner || agent), so a late rival CLAIM cannot move the holder and the
    // post-write attestation now agrees with the pre-write race: earliest wins, I hold, exit 0.
    // The rival's line still exists on the timeline - it is simply not ownership.
    const w = world({ rival: 'later' })
    const res = w.run(['coord', 'claim', '999999'])
    assert.equal(res.status, 0, `earliest holder keeps it: ${res.stderr}`)
    assert.match(res.stdout, /Claimed #999999/)
    assert.doesNotMatch(
      res.stderr,
      /STAND DOWN/,
      'the late rival no longer displaces me, so there is nothing to stand down from',
    )
    assert.doesNotMatch(
      res.stderr,
      /last protocol word/,
      'the last-word path is gone',
    )
    assert.doesNotMatch(res.stderr, /RE-READ/)
    assert.doesNotMatch(res.stderr, /round-trip/)
    w.done()
  })

  it('#102 keeps the EARLIER rival arm: losing the race is race.js, and it still refuses before the write', () => {
    // Non-vacuity pair for the arm above: both cannot be passing because the rival is ignored.
    // 'earlier' puts bravo's stamp BEFORE mine, so evaluateClaimRace (unchanged by #102) refuses
    // my write outright - the stand-down prose must still fire there.
    const w = world({ rival: 'earlier' })
    const res = w.run(['coord', 'claim', '999999'])
    assert.equal(res.status, 1)
    assert.match(res.stderr, /Lost simultaneous claim race to bravo/)
    w.done()
  })

  it('a refresh that never shows my line says RE-READ, and never says stand down', () => {
    const w = world({ mode: 'drop' })
    const res = w.run(['coord', 'claim', '999999'])
    assert.equal(res.status, 1)
    assert.match(res.stderr, /nobody holds #999999 \(0 comment\(s\) read\)/)
    assert.match(res.stderr, /RE-READ before you write anything/)
    assert.match(
      res.stderr,
      /--paginate/,
      'names the read that settles it, and the ceiling it can hit',
    )
    assert.doesNotMatch(res.stderr, /STAND DOWN/)
    w.done()
  })

  it('the lost-race message keeps precedence: the attestation runs after it, not before', () => {
    const w = world({ rival: 'earlier' })
    const res = w.run(['coord', 'claim', '999999'])
    assert.equal(res.status, 1)
    assert.match(res.stderr, /Lost simultaneous claim race to bravo/)
    assert.doesNotMatch(
      res.stderr,
      /does not resolve to agent-tester/,
      'the race names the cause first',
    )
    w.done()
  })

  it('the arms are not vacuous: the stub records what the assertions count', () => {
    const w = world({ mode: 'drop' })
    w.run(['coord', 'claim', '999999'])
    assert.ok(
      w.calls().length >= 3,
      `the shim was traveled: ${w.calls().length} calls`,
    )
    assert.equal(
      w.count('issue comment'),
      1,
      'the write happened; only the read hid it',
    )
    w.done()
  })
})
