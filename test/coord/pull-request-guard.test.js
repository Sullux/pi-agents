const { test } = require('node:test')
const assert = require('node:assert')
const { Cli } = require('../../src/cli')
const { CoordService } = require('../../src/coord')
const {
  linkedIssues,
  pullRequestRefusal,
  USAGE,
} = require('../../src/coord/issueNumber')

// pi-agents#30 - a coord verb takes an ISSUE number, and its only guard (`isIssueNumber`, #13) is a
// NUMBER check. GitHub issues and pull requests share one number sequence and `gh` resolves either,
// so a PR number passed today posts a protocol comment and stamps a label on a tree. Measured twice
// on pitcairn: `review 1138 --pr 1138` (intending `review 1136`) printed `Moved #1138 to in-review`,
// exit 0, and left the issue the board reads with nothing; a second run stamped merged PR #1110 and
// put a finished artifact back on the board as live.
//
// These arms fire on the API OBJECT'S SHAPE - the double answers `pull_request` present or absent for
// the same number - so no list of "numbers that happen to be PRs" can make them pass.
//
// #54: that sentence was only true of the POSITIONAL until now. The probe used to ignore the number it
// was handed and return one fixture-wide flag, which made the flag's own semantics (`--pr` legitimately
// addresses a pull request, so it must NOT be kind-checked) unfalsifiable: a guard that refused on the
// flag answered identically to the shipped one, and box 3 stayed green. `prNumbers` below makes the
// probe per-number, and the fixture floor arm keeps it that way.

const VERBS = ['claim', 'release', 'status', 'review', 'done']

const recorder = ({
  isPullRequest,
  prNumbers = [],
  body = '',
  title = 'feat: the thing',
} = {}) => {
  const writes = []
  // #54: numbers arrive as CLI strings on the `--pr` path and as integers from a programmatic caller,
  // so the set is normalized on both sides - otherwise a fixture that writes `prNumbers: [47]` and an
  // arm that calls `review(21, { pr: '47' })` silently disagree and the blindness is back.
  const prSet = new Set(prNumbers.map(String))
  return {
    writes,
    repo: 'Sullux/pi-agents',
    // #30: the kind probe is the ONLY thing that can see a PR - `gh issue view --json` has no
    // pull_request / isPullRequest field (measured: `Unknown JSON field`), so the service has to ask.
    issueKind: async (number) => ({
      isPullRequest: isPullRequest || prSet.has(String(number)),
      number,
      title,
      body,
    }),
    listIssues: async () => [],
    viewIssue: async () => ({
      number: 21,
      title: 'an issue',
      labels: [{ name: 'status:unclaimed' }],
      body: '## Files\nsrc/x.js\n',
      // #28's ownership guard is live, so `done` refuses without a self-claim: the issue-shaped arm
      // has to carry one or box 2 measures that guard instead of this one.
      comments: [
        { body: '**CLAIM** | agent: agent-delta | human: @Sullux | at: 1' },
      ],
    }),
    commentIssue: async (number, body) => {
      writes.push(['comment', number, body])
      return ''
    },
    editIssue: async (number, opts = {}) => {
      writes.push(['edit', number, opts])
      return ''
    },
    closeIssue: async (number) => {
      writes.push(['close', number])
      return ''
    },
  }
}

const serviceOver = (github) =>
  CoordService({ github, agent: 'delta', human: 'Sullux', now: () => 1 })

const callEach = async (github) => {
  const coord = serviceOver(github)
  return [
    ['claim', await coord.claim(21)],
    ['release', await coord.release(21)],
    ['status', await coord.status(21, 'text')],
    ['review', await coord.review(21, { pr: '34', text: 'verdict' })],
    ['done', await coord.done(21, { pr: '34' })],
  ]
}

test('box 1: every mutating verb refuses a number whose API object carries pull_request', async () => {
  const github = recorder({
    isPullRequest: true,
    body: 'Closes #21\n\nSome implementation prose.',
  })
  const results = await callEach(github)
  assert.equal(results.length, 5)
  for (const [verb, res] of results) {
    assert.equal(res.ok, false, `${verb} must refuse a pull request`)
    assert.match(
      res.error,
      /#21 is a PULL REQUEST/,
      `${verb}: names the number and the kind`,
    )
    assert.match(res.error, /not an issue/, `${verb}: says what it expected`)
    assert.match(
      res.error,
      /you meant issue #21/,
      `${verb}: prints the resolvable candidate`,
    )
    assert.match(
      res.error,
      new RegExp(`Usage: page coord ${verb}`),
      `${verb}: keeps the usage line`,
    )
  }
})

test('box 2: the SAME number passes when the API object has no pull_request key (fires on shape, not on a number list)', async () => {
  const asIssue = recorder({ isPullRequest: false })
  const results = await callEach(asIssue)
  for (const [verb, res] of results) {
    assert.notEqual(
      res.ok,
      false,
      `${verb}: an issue-number-shaped object is not refused`,
    )
  }
  // ...and the number is byte-identical between the two arms: 21 in both, so nothing here is a list.
  const asPull = recorder({ isPullRequest: true })
  const pullResults = await callEach(asPull)
  assert.ok(pullResults.every(([, r]) => r.ok === false))
  assert.ok(
    results.every(([, r]) => r.ok !== false),
    'the issue-shaped arm reached the verb bodies at all (never a silent refuse)',
  )
})

test('box 2: the guard reads the shape, not a hardcoded number - a never-seen number refuses identically', async () => {
  const github = recorder({
    isPullRequest: true,
    body: 'no closing keyword here',
  })
  const coord = serviceOver(github)
  const res = await coord.review(987654, { pr: '34', text: 'verdict' })
  assert.equal(
    res.ok,
    false,
    'an arbitrary number is judged by its object, not by a table',
  )
  assert.match(res.error, /#987654 is a PULL REQUEST/)
  assert.match(
    res.error,
    /No linked issue is resolvable/,
    'and it says so rather than inventing one',
  )
})

test('box 4: the refusal path writes NOTHING - no comment, no label, no close', async () => {
  const github = recorder({ isPullRequest: true, body: 'Refs #21' })
  const results = await callEach(github)
  assert.deepEqual(
    results.map(([, r]) => r.ok),
    [false, false, false, false, false],
  )
  assert.deepEqual(
    github.writes,
    [],
    'a typo must not half-apply the way the measured incident did',
  )
})

test('box 3: --pr stays a legitimate pull-request number (the guard checks the positional only)', async () => {
  // #54: 47 resolves AS a pull request in the double now, so this arm can actually see a guard that
  // kind-checked the flag - before the fixture change it got the same `isPullRequest: false` for 21 and
  // 47 and passed under any mutation of the positional/flag distinction.
  const github = recorder({ isPullRequest: false, prNumbers: ['47', 51] })
  const coord = serviceOver(github)
  const res = await coord.review(21, { pr: '47', text: 'verdict on the tree' })
  assert.notEqual(
    res.ok,
    false,
    'review with a real PR number in --pr must still work',
  )
  // The integer form, because the probe normalizes: a caller that passes a number instead of a string
  // is the same legitimate usage, and it is the half that rots first if normalization ever breaks.
  const resInt = await coord.review(21, {
    pr: 51,
    text: 'same verdict, integer flag',
  })
  assert.notEqual(
    resInt.ok,
    false,
    'a pull-request number given as an integer is still legal usage',
  )
  assert.ok(
    github.writes.some((w) => w[0] === 'comment' && w[2].includes('pr: #47')),
    'and the PR reference survives into the protocol comment',
  )
  assert.match(
    USAGE.review,
    /^review <issue>/,
    'the usage line names the positional as an issue',
  )
})

test('the #13 guards still hold unchanged (NaN, 0, 13.5, missing positional)', async () => {
  const github = recorder({ isPullRequest: false })
  const coord = serviceOver(github)
  for (const bad of [NaN, 0, 13.5, undefined, -2, Infinity]) {
    const res = await coord.claim(bad)
    assert.equal(res.ok, false, `${String(bad)} must still be refused`)
    assert.match(
      res.error,
      /invalid issue number/,
      `${String(bad)}: keeps #13's wording`,
    )
  }
  assert.deepEqual(github.writes, [], 'and none of them reached a write either')

  for (const bad of ['abc', '0', '', undefined]) {
    const out = []
    const err = []
    const cli = Cli({
      github: { repo: 'Sullux/pi-agents' },
      coordFactory: ({ agent }) =>
        CoordService({ github, agent, human: 'Sullux', now: () => 1 }),
      provenance: { describe: () => '', note: () => '' },
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
    })
    const status = await cli.run([
      'coord',
      'claim',
      ...(bad === undefined ? [] : [bad]),
    ])
    assert.equal(
      status,
      1,
      `${JSON.stringify(bad)}: the CLI still refuses before anything else`,
    )
    assert.match(
      err.join(' '),
      /missing issue number|invalid issue number/,
      `${String(bad)}`,
    )
  }
})

test('CLI: a pull-request positional exits 1 and prints the refusal, not a transition', async () => {
  const github = recorder({ isPullRequest: true, body: 'Closes #21' })
  const out = []
  const err = []
  const cli = Cli({
    github: { repo: 'Sullux/pi-agents' },
    coordFactory: ({ agent }) =>
      CoordService({ github, agent, human: 'Sullux', now: () => 1 }),
    provenance: { describe: () => '', note: () => '' },
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
  })
  // the measured accident, re-run: `review <n> --pr <n>` where <n> was a pull request
  const status = await cli.run([
    'coord',
    'review',
    '21',
    '--pr',
    '21',
    'verdict',
  ])
  assert.equal(status, 1, 'exit 1, the way a refusal must exit')
  assert.match(err.join(' '), /#21 is a PULL REQUEST/)
  assert.match(err.join(' '), /you meant issue #21/)
  assert.deepEqual(
    out,
    [],
    'nothing reaches stdout, so no grep can read this as a board move',
  )
  assert.deepEqual(
    github.writes,
    [],
    'the CLI refused before the service could write',
  )
})

test('linkedIssues reads the keywords GitHub itself parses, plus the fleet Refs form, and dedupes', () => {
  assert.deepEqual(linkedIssues('Closes #21'), ['21'])
  assert.deepEqual(linkedIssues('closes #21 and Fixes #30'), ['21', '30'])
  assert.deepEqual(
    linkedIssues('CLOSED #7\nfixed: #9\nresolves #11\nRefs #13'),
    ['7', '9', '11', '13'],
  )
  assert.deepEqual(
    linkedIssues('Refs #13 and ref #13'),
    ['13'],
    'one candidate per issue, not per mention',
  )
  assert.deepEqual(linkedIssues('this closes nothing and has no number'), [])
  assert.deepEqual(
    linkedIssues(undefined),
    [],
    'no body is no candidates, not a crash',
  )
  assert.deepEqual(
    linkedIssues('refactor #5 is not a closing keyword'),
    [],
    'a bare "ref" inside a subject line does not become a candidate',
  )
})

test('pullRequestRefusal names the number, the kind, the title, and stays one line', () => {
  const msg = pullRequestRefusal('done', 1138, {
    isPullRequest: true,
    title: 'feat(cli): done takes --force',
    body: 'Closes #1136',
  })
  assert.match(msg, /^Error: coord done: #1138 is a PULL REQUEST/)
  assert.match(
    msg,
    /feat\(cli\): done takes --force/,
    'the title disambiguates at a glance',
  )
  assert.match(msg, /issue #1136/)
  assert.match(
    msg,
    /Nothing was written/,
    'and it states the side-effect contract it keeps',
  )
  assert.equal(
    msg.split('\n').length,
    1,
    'one line, so it cannot be read as a multi-line report',
  )
})

test("the recorder's probe answers per-number - the fixture's own non-vacuity floor (#54)", async () => {
  const github = recorder({ isPullRequest: false, prNumbers: ['47', 51] })
  assert.equal(
    (await github.issueKind(21)).isPullRequest,
    false,
    'the issue-shaped number stays an issue',
  )
  assert.equal(
    (await github.issueKind('47')).isPullRequest,
    true,
    'a listed PR answers as a PR as a string',
  )
  assert.equal(
    (await github.issueKind(51)).isPullRequest,
    true,
    'and as an integer - the normalization is the point',
  )
  const blind = recorder({ isPullRequest: false })
  assert.equal(
    (await blind.issueKind(47)).isPullRequest,
    false,
    'with no prNumbers the probe is blind again, which is the state this floor exists to catch',
  )
})

test('an unresolvable number is not reported as a pull request (the probe is honest about not knowing)', async () => {
  const github = {
    ...recorder({ isPullRequest: false }),
    issueKind: async () => undefined,
  }
  const coord = serviceOver(github)
  const res = await coord.status(21, 'text')
  assert.notEqual(
    res.ok,
    false,
    'a missing kind probe falls through to the verb, which reads it itself',
  )
})
