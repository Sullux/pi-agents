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

  const open = await call(rows(3), { state: 'open', limit: 3 })
  assert.match(open.error.message, /on the open axis/)
  assert.match(open.error.message, /OPEN set is TRUNCATED/)
  assert.match(open.error.message, /scope gate/)
})
