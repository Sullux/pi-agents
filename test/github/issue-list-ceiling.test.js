const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { GitHubClient, ISSUE_PAGE_CEILING } = require('../../src/github')
const { CoordService } = require('../../src/coord')

// #85: `listIssues` asked gh for 100 rows, never compared the reply to that number, and swallowed a
// parse failure as `return []`. Both halves ended the same way at the scope gate: an EMPTY open set,
// which `checkScopeCollision` reads as "nobody declared that file" and answers hasCollision:false -
// measured, not argued. So the failure mode of a bad read was not a crash, it was a clean pass, and
// a clean pass is what an agent stops questioning.
//
// The distinction the whole file is built on: `[]` is a VALID answer (a repo with no open issues) and
// must stay silent, while an unreadable read is UNKNOWN and must refuse. If those two arms ever behave
// the same, this file is lying - which is the rule `test/coord/unclaimed-scope-collision.test.js`
// states for its own pair.

const rows = (n) =>
  JSON.stringify(Array.from({ length: n }, (_, i) => ({ number: i + 1 })))

const client = (reply) => {
  const argv = []
  const c = GitHubClient({
    execFile: (cmd, args) => {
      argv.push([cmd, ...args])
      return typeof reply === 'function' ? reply() : reply
    },
    repo: 'Sullux/pitcairn-portal',
  })
  return { c, argv }
}

const call = async (reply, options) => {
  const { c, argv } = client(reply)
  let error
  let issues
  try {
    issues = await c.listIssues(options)
  } catch (err) {
    error = err
  }
  // non-vacuity: the double must have been driven, or every arm below passes on a mock that never ran
  assert.ok(argv.length > 0, 'the execFile seam was never traveled')
  return { issues, error, argv }
}

describe('listIssues distinguishes an empty set from a failed read (#85)', () => {
  it('a valid [] is a result, not a failure: returned, and nothing is accused', async () => {
    const { issues, error } = await call('[]')
    assert.equal(error, undefined)
    assert.deepEqual(issues, [])
  })

  const unreadable = [
    ['empty stdout', ''],
    ['an html error body', '<html>Server Error</html>'],
    ['a warning line above valid json', 'warning: something\n[]'],
    ['truncated json', '[{"number":1}'],
  ]
  for (const [name, reply] of unreadable) {
    it(`refuses on ${name} instead of returning an empty collision set`, async () => {
      const { issues, error } = await call(reply)
      assert.ok(error, 'expected a throw, got a silent result')
      assert.match(error.message, /UNKNOWN, not empty/)
      assert.equal(
        issues,
        undefined,
        'a failed read must not also hand back a value',
      )
    })
  }

  it('refuses when the reply is exactly at the requested cap, and names the remedy', async () => {
    const { error } = await call(rows(3), { limit: 3 })
    assert.match(error.message, /TRUNCATED/)
    assert.match(error.message, /exactly 3 issues/)
    assert.match(error.message, /ISSUE_PAGE_CEILING/)
  })

  it('stays silent one row below the cap - the guard accuses at saturation, not always', async () => {
    const { issues, error } = await call(rows(2), { limit: 3 })
    assert.equal(error, undefined)
    assert.equal(issues.length, 2)
  })

  it('a refusal names the fault without dumping the payload it read', async () => {
    const huge = `<html>${'x'.repeat(5000)}</html>`
    const { error } = await call(huge)
    assert.ok(error, 'expected a throw on an html body')
    assert.ok(
      error.message.length < 400,
      `error text is ${error.message.length} chars - a wall of read output is how #41 made a repo-less
      call look like a body-quoting bug`,
    )
    assert.ok(
      !error.message.includes('xxx'),
      'the refusal echoed the payload it failed to parse',
    )
  })

  it('the ceiling sits ABOVE the old default of 100 and reaches gh as the limit', async () => {
    assert.ok(
      ISSUE_PAGE_CEILING > 100,
      `ISSUE_PAGE_CEILING is ${ISSUE_PAGE_CEILING}; the fix must sit above the 100 it replaces`,
    )
    const { argv } = await call(rows(1))
    const list = argv.find((a) => a.includes('list'))
    assert.ok(list.includes('--limit'), 'no --limit reached gh')
    assert.equal(list[list.indexOf('--limit') + 1], String(ISSUE_PAGE_CEILING))
  })

  it('claim refuses rather than reporting a clean gate when the tracker answers with garbage', async () => {
    // The real client over a fake gh, not a throwing double: a double that throws proves only that
    // CoordService propagates, which was already true at the broken tip and made the arm vacuous.
    // The defect was that a failed read came back as [], the gate said "nobody declared these
    // files", and the CLAIM LANDED. So this drives the shipped client and asserts nothing was written.
    const writes = []
    const issue = {
      number: 7,
      title: 't',
      body: '## Files\nsrc/github/index.js\n\n## Goal\nTest',
      labels: [],
      comments: [],
    }
    const gh = (args) => {
      if (args.includes('api'))
        return JSON.stringify({
          isPullRequest: false,
          title: 't',
          body: issue.body,
        })
      if (args.includes('view')) return JSON.stringify(issue)
      if (args.includes('list')) return '<html>Server Error</html>'
      writes.push(args[1])
      return ''
    }
    const github = GitHubClient({
      execFile: (cmd, args) => gh(args),
      repo: 'Sullux/pitcairn-portal',
    })
    const svc = CoordService({
      github,
      agent: 'alpha',
      human: 'Sullux',
      now: () => 1700000000000,
    })
    await assert.rejects(() => svc.claim(7), /UNKNOWN, not empty/)
    assert.deepEqual(
      writes,
      [],
      'a refused claim must write nothing, but the tracker saw ' +
        writes.join(', '),
    )
  })
})

// #107: the closed-axis sweep died on this cap because `--limit` cannot express a window. Two halves of one
// guard, both pinned against the execFile seam: the predicate travels when a caller names one, and the token
// is ABSENT - not empty, not merely falsy - when it does not. The negative half is the expensive one: a
// `--search` that leaked into the OPEN-axis read would silently narrow the collision set that `claim` and
// `board` depend on, which is a false "no collision" - and every positive-only pin stays green while it does.
it('--search travels when the caller names a predicate, on the axis it was asked for', async () => {
  const { issues, argv } = await call(rows(2), {
    state: 'closed',
    search: 'closed:>=2026-11-09',
  })
  const list = argv[argv.length - 1]
  assert.ok(
    list.includes('--search'),
    `no --search reached gh: ${list.join(' ')}`,
  )
  assert.equal(list[list.indexOf('--search') + 1], 'closed:>=2026-11-09')
  assert.equal(list[list.indexOf('--state') + 1], 'closed')
  assert.equal(issues.length, 2)
})

it('no --search token appears when the caller names none - absent, never empty', async () => {
  for (const options of [
    undefined,
    {},
    { state: 'open' },
    { state: 'closed' },
  ]) {
    const { argv } = await call(rows(1), options)
    const list = argv[argv.length - 1]
    assert.ok(
      !list.includes('--search'),
      `--search leaked into the ${JSON.stringify(options)} read, narrowing a set the gate depends on`,
    )
    assert.ok(
      !list.includes(''),
      `an empty argument reached gh for ${JSON.stringify(options)}`,
    )
  }
})

it('an empty-string search is not forwarded either: gh reads it as match-nothing', async () => {
  const { argv } = await call(rows(1), { state: 'closed', search: '' })
  const list = argv[argv.length - 1]
  assert.ok(!list.includes('--search'), 'an empty --search was forwarded')
})

it('the at-cap refusal names the axis it was asked for, not the one the gate cares about', async () => {
  const closed = await call(rows(3), { state: 'closed', limit: 3 })
  assert.ok(closed.error, 'expected a throw at the cap on the closed axis')
  assert.match(closed.error.message, /on the closed axis/)
  assert.match(closed.error.message, /CLOSED set is TRUNCATED/)
  assert.match(closed.error.message, /options\.search/)
  assert.ok(
    !closed.error.message.includes('scope gate'),
    'the closed-axis refusal still accuses the claim gate, which is what sent an agent hunting the wrong ' +
      'axis for a repo with four open issues',
  )

  // #111: the ceiling constant and the collision maxim must NOT ride the closed arm, or the refusal tells the next
  // operator to do the thing #107's rationale rejects - a bigger SHARED constant is the same cliff, longer, and a
  // sweep has no collision set. #113 amends this list: the PER-CALL limit is not a shared constant, it is the only
  // knob left once the read already carries a predicate, and it is measured effective - a 90-day sweep of
  // pitcairn refuses at the ceiling (500) and returns 558 rows at limit 1000 - so it belongs on both arms.
  for (const phrase of ['ISSUE_PAGE_CEILING', 'missed collision']) {
    assert.ok(
      !closed.error.message.includes(phrase),
      `the closed-axis refusal still offers open-axis advice (${phrase}): ${closed.error.message}`,
    )
  }
  assert.match(
    closed.error.message,
    /larger options\.limit/,
    'the closed-axis refusal dropped the one remedy that measurably sweeps an at-cap repo',
  )

  const open = await call(rows(3), { state: 'open', limit: 3 })
  assert.match(open.error.message, /on the open axis/)
  assert.match(open.error.message, /OPEN set is TRUNCATED/)
  assert.match(open.error.message, /scope gate/)
  // the open arm keeps every remedy, so the negative block above cannot be satisfied by deleting advice
  // from both branches - that would be a green on a message that no longer tells anyone what to do.
  assert.match(open.error.message, /ISSUE_PAGE_CEILING/)
  assert.match(open.error.message, /larger options\.limit/)
  assert.match(open.error.message, /missed collision/)
})

// #113: the closed arm's surviving instruction was `pass options.search` - and the only caller that can ever reach
// this refusal (preflight's closure sweep) ALWAYS passes that predicate, so the message advised a completed action
// and hid the knobs that are actually left. A search-bearing read must name the predicate it used and stop telling
// the operator to pass one; a search-FREE read must keep that advice, or the first half is satisfiable by deleting
// the sentence from both branches - which is the shape this file exists to refuse.
it('a search-bearing closed read at cap names the predicate it actually used, not one it already has', async () => {
  const search = 'closed:>=2026-08-12T00:00:00Z'
  const hit = await call(rows(3), { state: 'closed', limit: 3, search })
  assert.ok(
    hit.error,
    'expected a throw at the cap on a search-bearing closed read',
  )
  assert.ok(
    hit.error.message.includes(search),
    `the refusal did not name the predicate the call already carries: ${hit.error.message}`,
  )
  assert.ok(
    !hit.error.message.includes('pass options.search'),
    `the refusal still advises passing a search the caller already passed: ${hit.error.message}`,
  )
  // the two knobs that remain: the window (a tighter bound) and the per-call limit.
  assert.match(hit.error.message, /window/)
  assert.match(hit.error.message, /larger options\.limit/)
  for (const phrase of ['ISSUE_PAGE_CEILING', 'missed collision']) {
    assert.ok(
      !hit.error.message.includes(phrase),
      `the search-bearing closed arm still offers open-axis advice (${phrase})`,
    )
  }
  assert.ok(
    !hit.error.message.includes('scope gate'),
    'the search-bearing closed arm still accuses the claim gate',
  )
})

it('a search-FREE closed read at cap keeps the server-side advice (so the arm above cannot delete it)', async () => {
  const bare = await call(rows(3), { state: 'closed', limit: 3 })
  assert.ok(
    bare.error,
    'expected a throw at the cap on a search-free closed read',
  )
  assert.match(
    bare.error.message,
    /pass options\.search/,
    'a closed read with no predicate was not told to bound it server-side',
  )
  assert.match(bare.error.message, /larger options\.limit/)
  assert.ok(
    !bare.error.message.includes('scope gate'),
    'the search-free closed arm still accuses the claim gate',
  )
})

// #113 second half: `const limit = options.limit || ISSUE_PAGE_CEILING` silently reinterprets an explicit 0 as the
// ceiling, and `parsed.length === limit` is then vacuously true at 0 - so a caller that means "no limit" receives an
// at-cap refusal telling it to pass a larger limit, which is the value it already passed. gh itself rejects
// --limit 0 (measured: it errors and returns no rows), so the argv never carried a 0 and the fallback lives inside
// listIssues, not in gh. null and undefined must keep meaning "use the ceiling": preflight passes
// CLOSE_SCAN_LIMIT (null) on purpose.
it('an explicit limit of 0 is refused as a misuse, not silently reinterpreted as the ceiling', async () => {
  for (const bad of [0, -1, 2.5, 'x']) {
    const { c, argv } = client(rows(1))
    let error
    try {
      await c.listIssues({ state: 'closed', limit: bad })
    } catch (err) {
      error = err
    }
    assert.ok(
      error,
      `listIssues accepted options.limit = ${JSON.stringify(bad)} without complaint`,
    )
    assert.match(
      error.message,
      /options\.limit/,
      `the refusal for ${JSON.stringify(bad)} does not name the argument it rejected`,
    )
    assert.ok(
      !error.message.includes('TRUNCATED'),
      `${JSON.stringify(bad)} produced a truncation refusal instead of a misuse refusal`,
    )
    assert.equal(
      argv.length,
      0,
      `listIssues spawned gh despite an invalid limit (${JSON.stringify(bad)})`,
    )
  }
  const omitted = await call(rows(1), { state: 'closed', limit: null })
  assert.equal(
    omitted.error,
    undefined,
    'a null limit should fall back to the ceiling, not refuse',
  )
  const list = omitted.argv[omitted.argv.length - 1]
  const at = list.indexOf('--limit')
  assert.equal(
    Number(list[at + 1]),
    ISSUE_PAGE_CEILING,
    'a null limit did not reach gh as the ceiling',
  )
})
