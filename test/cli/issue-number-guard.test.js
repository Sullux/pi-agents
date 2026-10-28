const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const {
  USAGE,
  isIssueNumber,
  requireIssueNumber,
  requireMessage,
} = require('../../src/coord/issueNumber')
const { CoordService } = require('../../src/coord')

// pi-agents#13. `page coord <verb>` with no issue number parsed `Number(undefined)`
// into `NaN` and kept going. Measured at 71ade02 with a recording `gh` shim, the five
// mutating verbs did this:
//
//   claim    exit 1  "Error: #NaN declares no Files scope"  1 spawn (a read)
//   release  exit 0  "Released #NaN"                        2 spawns: issue comment + issue edit --add-label
//   status   exit 0  "Status updated on #NaN"               1 spawn:  issue comment
//   review   exit 0  "Moved #NaN to in-review"              3 spawns: comment + view + issue edit --add-label status:in-review
//   done     exit 0  "Marked #NaN done"                     3 spawns: comment + view + **issue close NaN**
//
// So four of five exited 0 while printing a success line, and three dispatched board
// WRITES - one of them a close. Against real `gh` the write throws first
// (`invalid issue format: "NaN"`), which is the stack trace #13 was filed with, and
// that throw is what turns the exit code into 1. The distinction matters: the CLI
// cannot tell a refused write from a completed one, because it never read `res`.
// The guard therefore has to be proven by SPAWN COUNT, not by exit code.

const repoRoot = join(__dirname, '..', '..')
const mutatingVerbs = ['claim', 'release', 'status', 'review', 'done']

// A `gh` that appends its argv to a log and answers `{}`. Every assertion below about
// "no write was attempted" is a count of lines in this file, which is the only shape
// that distinguishes "refused cleanly" from "crashed while attempting a write" - both
// exit nonzero. The control arms prove the shim is TRAVELED, because a shim that was
// never called would make every zero-assertion below vacuous.
const world = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi13-'))
  const log = join(dir, 'gh-calls.log')
  writeFileSync(
    join(dir, 'gh'),
    [
      '#!/bin/sh',
      'echo "$@" >> "$PI13_LOG"',
      'case "$*" in',
      '  *"issue list"*) echo "[]" ;;',
      '  *) echo "{}" ;;',
      'esac',
    ].join('\n') + '\n',
  )
  chmodSync(join(dir, 'gh'), 0o755)
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter((line) => line.trim())
      : []
  const run = (args) => {
    rmSync(log, { force: true })
    const res = spawnSync(
      process.execPath,
      [join(repoRoot, 'bin', 'page'), ...args],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          PI13_LOG: log,
          // Never address a real repo from a pin, whatever the guard does.
          COORD_REPO: 'Sullux/pi-agents-fake',
          COORD_AGENT: 'pi/tester',
        },
        // The verb is the argv, and `run()` reads process.argv.
      },
    )
    return res
  }
  return {
    dir,
    calls,
    run,
    done: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const runVerb = (world, verb, extra = []) =>
  world.run(['coord', verb, ...extra])

describe('#13 the argument validator refuses before anything is parsed downstream', () => {
  it('isIssueNumber takes exactly positive integers, and NaN is what a missing arg becomes', () => {
    assert.deepEqual(
      [
        undefined,
        '',
        ' ',
        null,
        'abc',
        '1.5',
        0,
        -3,
        NaN,
        Infinity,
        'NaN',
      ].filter(isIssueNumber),
      [],
      'every junk shape must be refused',
    )
    // strings are what argv actually is, and Number.isInteger is FALSE for them,
    // so the accepted path is requireIssueNumber (which parses first), not the raw predicate
    for (const good of ['13', '013', ' 13 ', 1, 13]) {
      assert.deepEqual(requireIssueNumber('claim', good), {
        value: Number(good),
      })
    }
    // the parsed-number form, because the bug was Number() output, not argv
    assert.equal(isIssueNumber(Number(undefined)), false)
  })

  it('requireIssueNumber names the verb arity and points at board', () => {
    const bad = requireIssueNumber('status', undefined)
    assert.equal(bad.value, undefined)
    assert.match(bad.error, /missing issue number/)
    assert.match(bad.error, /Usage: page coord status <issue> "<message>"/)
    assert.match(bad.error, /page coord board/)
    assert.doesNotMatch(
      bad.error,
      /NaN/,
      'the refusal must not echo the junk value as an id',
    )
    assert.deepEqual(requireIssueNumber('done', '42'), { value: 42 })
    // an invalid-but-present value says so, rather than reporting it as absent
    assert.match(
      requireIssueNumber('claim', '1e1.5').error,
      /invalid issue number/,
    )
  })

  it('requireMessage refuses a contentless protocol line', () => {
    assert.deepEqual(requireMessage('status', 'posted'), { value: 'posted' })
    assert.match(requireMessage('status', '   ').error, /missing message/)
    assert.match(requireMessage('review', '').error, /missing message/)
    // the arity it prints is the same table the CLI enforces, so they cannot drift
    for (const verb of mutatingVerbs) assert.ok(USAGE[verb], verb)
  })
})

describe('#13 the coord service cannot reach a gh write with a bad number', () => {
  // In-process, because box 2 is about ANY caller, not just the CLI. The recorder is
  // the witness: zero calls proves the guard sits BEFORE the spawn, and the control
  // arm proves a valid number does reach it (otherwise "zero" means nothing).
  const serviceWith = () => {
    const calls = []
    const github = {
      viewIssue: async (n) => {
        calls.push(['viewIssue', n])
        return {
          number: n,
          body: '## Files\nsrc/foo.js',
          labels: [],
          comments: [],
        }
      },
      listIssues: async () => {
        calls.push(['listIssues'])
        return []
      },
      commentIssue: async (n, body) => {
        calls.push(['commentIssue', n])
        return { ok: true }
      },
      editIssue: async (n) => {
        calls.push(['editIssue', n])
        return { ok: true }
      },
      closeIssue: async (n) => {
        calls.push(['closeIssue', n])
        return { ok: true }
      },
    }
    const coord = CoordService({ github, agent: 'pi/tester' })
    return { coord, calls }
  }

  it('all five verbs refuse NaN and dispatch no github call at all', async () => {
    const { coord, calls } = serviceWith()
    const results = await Promise.all([
      coord.claim(NaN),
      coord.release(NaN),
      coord.status(NaN),
      coord.review(NaN),
      coord.done(NaN),
    ])
    for (const res of results) {
      assert.equal(res.ok, false)
      assert.match(res.error, /invalid issue number NaN/)
    }
    assert.deepEqual(calls, [], 'the guard must run before any spawn')
  })

  it('control: a valid number DOES reach the github client (so zero above is a result)', async () => {
    const { coord, calls } = serviceWith()
    const res = await coord.status(42, 'still working')
    assert.equal(res.ok, true)
    assert.deepEqual(
      calls,
      [['commentIssue', 42]],
      'status comments and nothing else',
    )
  })

  it('control: a valid done still reaches closeIssue, and a bad one never does', async () => {
    const { coord, calls } = serviceWith()
    await coord.done(43, { pr: '44' })
    assert.ok(
      calls.some(([name]) => name === 'closeIssue'),
      'the close path is live for a valid number',
    )
    const fresh = serviceWith()
    await fresh.coord.done(NaN)
    assert.deepEqual(fresh.calls, [], 'no close dispatched for NaN')
  })
})

describe('#13 the CLI refuses the no-arg form for every mutating verb', () => {
  const w = world()
  it('clean usage refusal: nonzero exit, arity named, no crash noise, zero spawns', () => {
    for (const verb of mutatingVerbs) {
      const res = runVerb(w, verb)
      const merged = `${res.stdout}${res.stderr}`
      assert.notEqual(res.status, 0, `${verb} must exit nonzero`)
      assert.match(
        res.stderr,
        new RegExp(`Usage: page coord ${verb} `),
        `${verb} must name its own arity`,
      )
      assert.match(
        res.stderr,
        /page coord board/,
        `${verb} must point at the queue`,
      )
      assert.doesNotMatch(
        merged,
        /Command failed/,
        `${verb} must not crash in a spawn`,
      )
      assert.doesNotMatch(merged, /NaN/, `${verb} must not echo NaN as an id`)
      assert.doesNotMatch(
        merged,
        /undefined/,
        `${verb} must not leak the raw positional`,
      )
      assert.equal(
        res.stdout.trim(),
        '',
        `${verb} must not print a success line`,
      )
      assert.deepEqual(w.calls(), [], `${verb} dispatched a board call`)
    }
  })

  it('a present-but-junk number is refused the same way, with the value quoted', () => {
    for (const junk of ['abc', '0', '1.5', 'NaN', '1e1.5']) {
      const res = runVerb(w, 'status', [junk, 'msg'])
      assert.notEqual(res.status, 0, junk)
      assert.match(res.stderr, /invalid issue number/, junk)
      assert.match(
        res.stderr,
        new RegExp(`invalid issue number "${junk}"`),
        `must quote the value it rejected: ${junk}`,
      )
      assert.match(res.stderr, /page coord board/, junk)
      assert.deepEqual(w.calls(), [], junk)
    }
  })

  it('an empty positional is reported as missing, not as an invalid value', () => {
    // `Number('')` is 0, which is why the empty string must read as absent: quoting it
    // back as `invalid issue number ""` would send the reader hunting for a bad number
    // when what they forgot was the number entirely.
    const res = runVerb(w, 'status', ['', 'msg'])
    assert.notEqual(res.status, 0)
    assert.match(res.stderr, /missing issue number/)
    assert.doesNotMatch(res.stderr, /invalid issue number/)
    assert.deepEqual(w.calls(), [])
  })

  it('a flag-shaped junk value is refused too, naming what it actually got', () => {
    // measured at this tip: parseArgs turns `-1` into flags {1:true}, so `positionals`
    // become ['status','msg'] and the MESSAGE is what reaches the number slot. The guard
    // still refuses before any spawn, and it quotes `msg` rather than inventing a number.
    const res = runVerb(w, 'status', ['-1', 'msg'])
    assert.notEqual(res.status, 0)
    assert.match(res.stderr, /invalid issue number "msg"/)
    assert.deepEqual(w.calls(), [])
  })

  it('a missing message is refused before any spawn, for the two verbs whose body IS the message', () => {
    for (const verb of ['status', 'review']) {
      const res = runVerb(w, verb, ['999999'])
      assert.notEqual(res.status, 0, verb)
      assert.match(res.stderr, /missing message/, verb)
      assert.deepEqual(w.calls(), [], verb)
    }
  })

  it('control: a valid status travels to commentIssue and writes NO labels', () => {
    // box 4: `status N "msg"` still posts a comment and does not move labels. Pinned
    // on the shim's argv, because the fleet depends on status being comment-only.
    const res = runVerb(w, 'status', ['999999', 'still working'])
    const spawns = w.calls()
    assert.ok(spawns.length > 0, 'the harness must be able to see a real call')
    assert.ok(
      spawns.some((line) => line.startsWith('issue comment 999999')),
      `expected a comment spawn, got: ${spawns.join(' | ')}`,
    )
    assert.ok(
      !spawns.some((line) => line.startsWith('issue edit')),
      'status must not touch labels',
    )
    assert.equal(res.status, 0)
    assert.match(res.stdout, /Status updated on #999999/)
  })

  it('control: a valid claim and a valid done both reach the board (so their zero above bites)', () => {
    const claimed = runVerb(w, 'claim', ['999999'])
    assert.ok(w.calls().length > 0, 'claim reached gh')
    assert.match(
      `${claimed.stdout}${claimed.stderr}`,
      /Claimed #999999|declares no Files scope|not found|collides/,
    )
    const finished = runVerb(w, 'done', ['999999'])
    assert.ok(
      w.calls().some((line) => line.startsWith('issue close')),
      'a valid done does attempt the close - which is why the NaN arm matters',
    )
    assert.equal(finished.status, 0)
  })

  it('the read-only verbs are untouched by the guard', () => {
    const board = w.run(['coord', 'board'])
    assert.equal(board.status, 0)
    assert.match(board.stdout, /== board ==/)
  })
})
