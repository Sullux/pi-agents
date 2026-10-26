const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { cleanAgent, ownerOf, isMine } = require('../../src/coord/owner')
const { parseScope, checkScopeCollision } = require('../../src/coord/scope')
const { evaluateClaimRace, liveClaims } = require('../../src/coord/race')

describe('Coordination Engine: Owner Resolution', () => {
  it('cleanAgent normalizes agent callsigns', () => {
    assert.equal(cleanAgent('pi/agent-alpha'), 'alpha')
    assert.equal(cleanAgent('@alpha'), 'alpha')
    assert.equal(cleanAgent('agent-delta '), 'delta')
    assert.equal(cleanAgent('foxtrot'), 'foxtrot')
    assert.equal(cleanAgent('Delta'), 'delta')
    assert.equal(cleanAgent('agent-Delta'), 'delta')
  })

  it('ownerOf determines ownership from protocol comments', () => {
    const issueWithClaim = {
      comments: [
        { body: 'regular discussion comment' },
        {
          body: '**CLAIM** | agent: agent-alpha | human: @Sullux | at: 2026-09-27T10:00:00Z\n\nplan: fix',
        },
      ],
    }
    assert.equal(ownerOf(issueWithClaim), 'alpha')

    const issueWithRelease = {
      comments: [
        ...issueWithClaim.comments,
        { body: '**RELEASE** | lost claim race to agent-bravo' },
      ],
    }
    assert.equal(ownerOf(issueWithRelease), '')

    const issueWithHandoff = {
      comments: [
        ...issueWithClaim.comments,
        { body: '**HANDOFF** | to: @agent-charlie | reason: switching tasks' },
      ],
    }
    assert.equal(ownerOf(issueWithHandoff), 'charlie')

    const issueWithDone = {
      comments: [...issueWithHandoff.comments, { body: '**DONE** | pr: #123' }],
    }
    assert.equal(ownerOf(issueWithDone), '')
  })

  it('isMine correctly checks caller ownership against protocol comments', () => {
    const issue = {
      comments: [{ body: '**CLAIM** | agent: pi/agent-echo | human: @Sullux' }],
    }
    assert.equal(isMine(issue, 'agent-echo'), true)
    assert.equal(isMine(issue, 'echo'), true)
    assert.equal(isMine(issue, 'Echo'), true)
    assert.equal(isMine(issue, 'pi/Echo'), true)
    assert.equal(isMine(issue, 'delta'), false)
  })
})

describe('Coordination Engine: Scope & Collisions', () => {
  it('parseScope extracts declared Files from issue body', () => {
    const bodyWithFiles =
      '## Goal\nfoo\n\n## Files\nsrc/server/routes.js\nsrc/client/app.js\n\n## Notes'
    assert.deepEqual(parseScope(bodyWithFiles), [
      'src/server/routes.js',
      'src/client/app.js',
    ])

    const bodyWithoutFiles = '## Goal\nfoo\n\n## Files\n_(none listed)_\n'
    assert.deepEqual(parseScope(bodyWithoutFiles), [])

    const emptyBody = '## Goal\nno files section here'
    assert.deepEqual(parseScope(emptyBody), [])
  })

  it('checkScopeCollision detects file overlaps with active peer claims', () => {
    const activeIssues = [
      {
        number: 101,
        body: '## Files\nsrc/server/routes.js\nsrc/db.js',
        comments: [{ body: '**CLAIM** | agent: agent-alpha' }],
      },
      {
        number: 102,
        body: '## Files\nsrc/client/main.js',
        comments: [{ body: '**CLAIM** | agent: agent-bravo' }],
      },
    ]

    const targetScopeOverlap = ['src/server/routes.js', 'src/utils.js']
    const clash = checkScopeCollision(targetScopeOverlap, activeIssues, 'delta')
    assert.equal(clash.hasCollision, true)
    assert.equal(clash.collidingIssue, 101)
    assert.equal(clash.collidingAgent, 'alpha')
    assert.equal(clash.collidingFile, 'src/server/routes.js')

    const targetScopeClean = ['src/utils.js']
    const clean = checkScopeCollision(targetScopeClean, activeIssues, 'delta')
    assert.equal(clean.hasCollision, false)
  })
})

describe('Coordination Engine: Race Arbitration', () => {
  const claim = (id, createdAt, agent) => ({
    id,
    createdAt,
    body: `**CLAIM** | agent: agent-${agent} | human: @Sullux`,
  })
  const terminating = (kind) => (id, createdAt, agent) => ({
    id,
    createdAt,
    body: `**${kind}** | agent: agent-${agent} | reason: test`,
  })
  const release = terminating('RELEASE')
  const done = terminating('DONE')
  const handoff = terminating('HANDOFF')

  it('detects if peer claimed earlier in a simultaneous race', () => {
    const comments = [
      {
        id: 'c1',
        createdAt: '2026-09-27T10:00:15Z',
        body: '**CLAIM** | agent: agent-alpha | human: @Sullux',
      },
      {
        id: 'c2',
        createdAt: '2026-09-27T10:00:19Z',
        body: '**CLAIM** | agent: agent-bravo | human: @Sullux',
      },
    ]

    const bravoResult = evaluateClaimRace(comments, 'bravo')
    assert.equal(bravoResult.won, false)
    assert.equal(bravoResult.earlierAgent, 'alpha')

    const alphaResult = evaluateClaimRace(comments, 'alpha')
    assert.equal(alphaResult.won, true)
  })

  it('a RELEASEd claim stops blocking later claimants (#800 orphaned a p1 this way)', () => {
    // pitcairn-portal#800's real timeline: bravo claimed, released 7 minutes later,
    // and delta's claim an hour after that was refused as a lost "simultaneous" race.
    const comments = [
      claim('c1', '2026-10-26T17:44:19Z', 'bravo'),
      release('c2', '2026-10-26T17:51:12Z', 'bravo'),
      claim('c3', '2026-10-26T18:39:03Z', 'delta'),
    ]

    assert.deepEqual(
      liveClaims(comments).map((c) => c.agent),
      ['delta'],
    )
    assert.equal(evaluateClaimRace(comments, 'delta').won, true)
    // the release is symmetric: bravo no longer holds it either
    const bravoResult = evaluateClaimRace(comments, 'bravo')
    assert.equal(bravoResult.won, false)
    assert.equal(bravoResult.earlierAgent, 'delta')
  })

  it('arbitrates on the earliest LIVE claim, not the earliest ever', () => {
    const comments = [
      claim('c1', '2026-09-27T10:00:00Z', 'alpha'),
      release('c2', '2026-09-27T10:00:10Z', 'alpha'),
      claim('c3', '2026-09-27T10:00:20Z', 'bravo'),
      claim('c4', '2026-09-27T10:00:30Z', 'delta'),
    ]

    assert.equal(evaluateClaimRace(comments, 'bravo').won, true)
    const deltaResult = evaluateClaimRace(comments, 'delta')
    assert.equal(deltaResult.won, false)
    assert.equal(deltaResult.earlierAgent, 'bravo')
    assert.equal(evaluateClaimRace(comments, 'alpha').earlierAgent, 'bravo')
  })

  it('DONE and HANDOFF release a claim exactly like RELEASE does', () => {
    const afterDone = [
      claim('c1', '2026-09-27T10:00:00Z', 'alpha'),
      done('c2', '2026-09-27T10:00:10Z', 'alpha'),
      claim('c3', '2026-09-27T10:00:20Z', 'bravo'),
    ]
    assert.equal(evaluateClaimRace(afterDone, 'bravo').won, true)

    const afterHandoff = [
      claim('c1', '2026-09-27T10:00:00Z', 'alpha'),
      handoff('c2', '2026-09-27T10:00:10Z', 'alpha'),
      claim('c3', '2026-09-27T10:00:20Z', 'bravo'),
    ]
    assert.equal(evaluateClaimRace(afterHandoff, 'bravo').won, true)
  })

  it('a STATUS or discussion comment does not terminate a claim', () => {
    // #800 also carries `**STATUS** - agent-bravo, claimed.` between the claim and
    // the release; treating every protocol-looking marker as a terminator would
    // disarm a claimant who merely posted progress.
    const comments = [
      claim('c1', '2026-09-27T10:00:00Z', 'alpha'),
      {
        id: 'c2',
        createdAt: '2026-09-27T10:00:05Z',
        body: '**STATUS** - agent-alpha, claimed. Findings so far...',
      },
      { id: 'c3', createdAt: '2026-09-27T10:00:06Z', body: 'plain discussion' },
      claim('c4', '2026-09-27T10:00:10Z', 'bravo'),
    ]

    assert.deepEqual(
      liveClaims(comments).map((c) => c.agent),
      ['alpha', 'bravo'],
    )
    assert.equal(evaluateClaimRace(comments, 'alpha').won, true)
    assert.equal(evaluateClaimRace(comments, 'bravo').earlierAgent, 'alpha')
  })

  it('an agent that releases then re-claims is live again from the re-claim', () => {
    const reclaimed = [
      claim('c1', '2026-09-27T10:00:00Z', 'alpha'),
      release('c2', '2026-09-27T10:00:10Z', 'alpha'),
      claim('c3', '2026-09-27T10:00:30Z', 'alpha'),
      claim('c4', '2026-09-27T10:00:40Z', 'bravo'),
    ]
    assert.equal(evaluateClaimRace(reclaimed, 'alpha').won, true)

    // ...but a peer who claimed inside the gap keeps it: alpha's re-claim is later
    const lostTheGap = [
      claim('c1', '2026-09-27T10:00:00Z', 'alpha'),
      release('c2', '2026-09-27T10:00:10Z', 'alpha'),
      claim('c3', '2026-09-27T10:00:20Z', 'bravo'),
      claim('c4', '2026-09-27T10:00:30Z', 'alpha'),
    ]
    assert.equal(evaluateClaimRace(lostTheGap, 'alpha').won, false)
    assert.equal(evaluateClaimRace(lostTheGap, 'alpha').earlierAgent, 'bravo')
  })

  it('breaks a same-instant tie by comment id (Rule C)', () => {
    const sameInstant = '2026-09-27T10:00:00Z'
    // deliberately listed out of order: the sort, not the array, must decide
    const comments = [
      claim('c9', sameInstant, 'zulu'),
      claim('c1', sameInstant, 'bravo'),
    ]

    assert.deepEqual(
      liveClaims(comments).map((c) => c.id),
      ['c1', 'c9'],
    )
    assert.equal(evaluateClaimRace(comments, 'bravo').won, true)
    assert.equal(evaluateClaimRace(comments, 'zulu').earlierAgent, 'bravo')
  })

  it('a timeline with no live claims cannot lose a race', () => {
    const allReleased = [
      claim('c1', '2026-09-27T10:00:00Z', 'alpha'),
      release('c2', '2026-09-27T10:00:10Z', 'alpha'),
    ]

    assert.deepEqual(liveClaims(allReleased), [])
    assert.equal(evaluateClaimRace(allReleased, 'delta').won, true)
    assert.equal(evaluateClaimRace([], 'delta').won, true)
  })
})

// #816: parseScope's heading match was UNANCHORED - `/## Files\s*([\s\S]*?)(?:\n##|$)/` matched
// the first occurrence of that character sequence anywhere in the body, not a heading at the
// start of a line. An issue ABOUT the Files section has to mention the heading in prose, so the
// match landed on the mention and its prose became the scope while the declared paths were
// dropped entirely. Fenced examples had the same effect from the other direction.
describe('Coordination Engine: Scope Parsing (#816)', () => {
  it('anchors the Files heading to a line start, so prose that mentions it is not scope', () => {
    const body = [
      '# Bug: the Files section parser',
      '',
      'An issue ABOUT the Files section has to mention ## Files in prose, so the match lands here.',
      'It captures everything up to the next H2 as scope.',
      '',
      '## Goal',
      'fix it',
      '',
      '## Files',
      'src/coord/scope.js',
      'test/coord/coord.test.js',
      '',
      '## Notes',
      'none',
    ].join('\n')

    const scope = parseScope(body)
    assert.deepEqual(scope, ['src/coord/scope.js', 'test/coord/coord.test.js'])
    // the two halves of the defect, separately: prose must not be scope, and the real paths
    // must not be lost. Asserting only the first would pass on a parser that returns [].
    assert.equal(
      scope.some((entry) => entry.includes('prose')),
      false,
      'prose from the mention is not scope',
    )
    assert.ok(scope.length > 0, 'the declared paths were still parsed')
  })

  it('skips fenced code blocks, so a documented example is not scope', () => {
    const body = [
      '## Goal',
      'Document the expected shape:',
      '```md',
      '## Files',
      'docs/example/path.js',
      '```',
      '',
      '## Files',
      'src/real/path.js',
    ].join('\n')

    assert.deepEqual(parseScope(body), ['src/real/path.js'])
  })

  it('does not open a Files section from inside a fence at all', () => {
    const body = ['## Goal', '```md', '## Files', 'docs/example/path.js', '```', ''].join('\n')

    assert.deepEqual(parseScope(body), [])
  })

  it('keeps the existing section and comment behaviour', () => {
    // an H2 closes the section, as the old `\n##` terminator did
    assert.deepEqual(parseScope('## Files\nsrc/a.js\n\n## Notes\nsrc/not-scope.js'), ['src/a.js'])
    // an H3 subsection stays content and is dropped by the `#` filter, rather than closing it
    assert.deepEqual(parseScope('## Files\n### Backend\nsrc/a.js'), ['src/a.js'])
    // `_(none listed)_` placeholders and `#` comments are still dropped
    assert.deepEqual(parseScope('## Files\n_(none listed)_\n# a comment\n'), [])
    // no Files section at all
    assert.deepEqual(parseScope('## Goal\nnothing declared'), [])
  })

  it('a prose subsection inside Files cannot fabricate a collision (#800 case)', () => {
    // #800 was refused by the bash variant with "scope overlaps #747 on: the,the,the,for,the..."
    // - English function words from a prose subsection, matched word-for-word against an
    // unrelated issue's Files list. The canonical gate compares whole lines, so prose cannot
    // equal a path. Pinned here so that stays true if the gate is ever retokenized.
    const annotatedRoute = {
      number: 747,
      body: '## Files\nsrc/sites/admin/src/pages/bookings.astro\npublic/js/admin/bookings.js',
      comments: [{ body: '**CLAIM** | agent: agent-delta' }],
    }
    const proseAnnotated = {
      number: 800,
      body: [
        '## Files',
        'test/e2e/clock-shim.cjs',
        '',
        '### Narrowing',
        'the harness only, not the engine - for the clock, the +the pinned instant is the fix',
        '',
        '## Notes',
        'none',
      ].join('\n'),
      comments: [{ body: '**CLAIM** | agent: agent-bravo' }],
    }

    const scope = parseScope(proseAnnotated.body)
    // The declared path survives, and an H3 subsection heading does not close the section.
    assert.ok(scope.includes('test/e2e/clock-shim.cjs'), 'the declared path is scope')
    assert.equal(
      scope.some((entry) => entry.startsWith('#')),
      false,
      'the H3 heading is not a scope entry',
    )
    // Prose INSIDE the Files section is still taken as a line - there is no reliable way to tell
    // a path from a sentence - but it cannot fabricate a collision, because the canonical gate
    // compares whole lines and a sentence never equals a path. That is the property the bash
    // variant lacks (it tokenizes on spaces, so "the" equals "the").
    assert.equal(
      checkScopeCollision(scope, [annotatedRoute], 'bravo').hasCollision,
      false,
      'an unrelated issue with a prose-annotated Files section must stay claimable',
    )
  })
})

// #820/#770: a declared path arrives DECORATED. #820 lists `- \`src/sites/.../post.astro\``
// (bullet + backticks); #770 joins two paths on ONE line with `;`. Compared verbatim neither
// equals a bare path, so the gate returned hasCollision:false on a pair that overlaps on TWO
// files - while #820's own body says "expect the scope gate to require a split: line in #770's
// BODY before a claim goes through". Measured across every live claim: 1 collision detected
// today, 4 real ones missed, 0 false positives.
describe('Coordination Engine: Scope Normalization (#820)', () => {
  it('strips list bullets and backticks from a declared path', () => {
    assert.deepEqual(parseScope('## Files\n- `src/a.js`\n* src/b.js\n- src/c.js'), [
      'src/a.js',
      'src/b.js',
      'src/c.js',
    ])
  })

  it('splits paths joined on one line with a semicolon', () => {
    assert.deepEqual(parseScope('## Files\nsrc/a.js;test/e2e/a.spec.js'), [
      'src/a.js',
      'test/e2e/a.spec.js',
    ])
  })

  it('does not mangle a glob, whose ** must survive the bullet strip', () => {
    assert.deepEqual(parseScope('## Files\nsrc/server/events/ontology/**\n- `src/x/**`'), [
      'src/server/events/ontology/**',
      'src/x/**',
    ])
  })

  it('still drops placeholders and comments, which normalization must not resurrect', () => {
    assert.deepEqual(parseScope('## Files\n_(none listed)_\n# a comment\n- `_(none)_`\n'), [])
  })

  it('the #820 claim now collides with #770 on the two files they really share', () => {
    const inFlight = {
      number: 770,
      body: '## Files\nsrc/sites/resident/src/pages/post.astro;test/e2e/resident.spec.js',
      comments: [{ body: '**CLAIM** | agent: agent-delta' }],
    }
    const decorated = [
      '- `src/sites/resident/src/pages/post.astro`',
      '- `src/sites/resident/src/pages/passage.astro`',
      '- `src/sites/vendor/src/pages/calendar.astro`',
      '- `public/styles/global.css`',
      '- `test/e2e/resident.spec.js`',
    ]
    const scope = parseScope(['## Files', ...decorated].join('\n'))

    const clash = checkScopeCollision(scope, [inFlight], 'bravo')
    assert.equal(clash.hasCollision, true, 'a real two-file overlap must not pass the gate')
    assert.equal(clash.collidingIssue, 770)
    assert.deepEqual(
      clash.collidingFiles.slice().sort(),
      ['src/sites/resident/src/pages/post.astro', 'test/e2e/resident.spec.js'].sort(),
      'both shared files are named, so the agent can judge whether a split is viable',
    )
    assert.ok(
      clash.collidingFiles.includes(clash.collidingFile),
      'the legacy single-file field stays the first of the set',
    )
  })
})

// #826: `gh issue list --json comments` returns only the FIRST 100 comments of an issue
// (measured on hub #4: 100 returned against 645 real), and every consumer here is
// timeline-dependent - `slice(-5)` for the hub tail, last-protocol-comment-wins for OWNER.
// Slicing the end of a truncated array does not degrade gradually: it freezes forever.
describe('Coordination Engine: comment-timeline completeness', () => {
  const CEILING = 100
  const { CoordService } = require('../../src/coord/index')

  const claimOf = (agent) => ({
    body: `**CLAIM** | agent: agent-${agent} | human: @Sullux | at: 1`,
  })
  const releaseOf = (agent) => ({
    body: `**RELEASE** | agent: agent-${agent} | reason: standing down`,
  })
  const filler = (n) => Array.from({ length: n }, (_, i) => ({ body: `c${i}` }))

  const FakeGithub = ({ issues, viewed = {} }) => {
    const calls = { viewIssue: [], commentIssue: [], editIssue: [] }
    return {
      calls,
      repo: 'test/repo',
      listIssues: async () => issues,
      viewIssue: async (number) => {
        calls.viewIssue.push(number)
        return viewed[number]
      },
      commentIssue: async (number, body) => {
        calls.commentIssue.push([number, body])
        return ''
      },
      editIssue: async (number, opts) => {
        calls.editIssue.push([number, opts])
        return ''
      },
      closeIssue: async () => '',
    }
  }

  const coordOver = (github) =>
    CoordService({ github, agent: 'delta', human: 'Sullux', now: () => 1 })

  const hubIssue = (comments) => ({
    number: 4,
    title: 'coordination hub',
    labels: [{ name: 'hub' }],
    body: '',
    comments,
  })

  it("sync's hub tail is the FULL timeline's last five, not the first page's", async () => {
    const listed = hubIssue(filler(CEILING)) // what gh issue list hands back
    const markers = ['TAIL-1', 'TAIL-2', 'TAIL-3', 'TAIL-4', 'TAIL-5']
    const full = hubIssue([
      ...filler(CEILING),
      ...markers.map((m) => ({ body: m })),
    ])
    const github = FakeGithub({ issues: [listed], viewed: { 4: full } })

    const out = await coordOver(github).sync()

    for (const marker of markers) {
      assert.ok(
        out.includes(marker),
        `the genuinely-latest ${marker} must be printed`,
      )
    }
    // Non-vacuity: the first page's own tail must be GONE. Without this the pin would pass
    // on a fixture whose two sources agree, i.e. with the bug still live.
    for (const stale of ['c95', 'c96', 'c97', 'c98', 'c99']) {
      assert.ok(
        !out.includes(stale),
        `stale first-page comment ${stale} must not be printed`,
      )
    }
    assert.deepEqual(
      github.calls.viewIssue,
      [4],
      'the hub was re-fetched, and only the hub',
    )
  })

  it('prints the last five COMMENTS - the header no longer claims a SYNC filter that never existed', async () => {
    const github = FakeGithub({ issues: [hubIssue(filler(3))] })

    const out = await coordOver(github).sync()

    assert.ok(
      out.includes('last 5 comments'),
      out.split('\n').find((l) => l.includes('== hub')),
    )
    assert.ok(
      !out.includes('SYNC'),
      'hub() posts no **SYNC** marker, so the old header lied',
    )
    assert.ok(
      out.includes('c2') && !out.includes('c95'),
      'tail still printed below the ceiling',
    )
  })

  it('does not re-fetch when nothing reached the ceiling', async () => {
    const github = FakeGithub({ issues: [hubIssue(filler(CEILING - 1))] })

    const out = await coordOver(github).sync()

    assert.deepEqual(
      github.calls.viewIssue,
      [],
      'no extra gh call for a complete timeline',
    )
    assert.ok(out.includes(`c${CEILING - 2}`), 'the listed tail is used as-is')
  })

  it('resolves the board OWNER from the full timeline, not the truncated one', async () => {
    // 100 comments whose visible tail is a RELEASE: bravo looks like they let go.
    const listedComments = [
      ...filler(CEILING - 2),
      claimOf('bravo'),
      releaseOf('bravo'),
    ]
    const body = '## Files\nsrc/a.js'
    const labels = [{ name: 'status:claimed' }]
    const listed = {
      number: 800,
      title: 'a task',
      labels,
      body,
      comments: listedComments,
    }
    // The real timeline has one more comment: foxtrot claimed after the release.
    const full = {
      ...listed,
      comments: [...listedComments, claimOf('foxtrot')],
    }
    const github = FakeGithub({ issues: [listed], viewed: { 800: full } })

    const out = await coordOver(github).board()
    const row = out.split('\n').find((l) => l.startsWith('#800'))

    assert.ok(row, 'the row rendered')
    assert.ok(
      row.includes('foxtrot'),
      `owner must come from the full timeline, got: ${row}`,
    )
    assert.ok(
      !row.includes('bravo'),
      'a claimant who released must not render as owner',
    )
    assert.deepEqual(
      github.calls.viewIssue,
      [800],
      'the >100-comment issue was re-fetched',
    )
  })

  it('renders a >100-comment issue OWNERLESS when the full timeline ends in a RELEASE', async () => {
    // The mirror of the pin above: the truncated view ends CLAIMED by bravo, while the
    // real timeline has one more comment in which bravo let go. Rendering bravo here is
    // what makes an agent skip a free issue - or worse, post a duplicate claim.
    const listedComments = [...filler(CEILING - 1), claimOf('bravo')]
    const listed = {
      number: 800,
      title: 'a task',
      // ws and p are populated on purpose: with the default '-' in every column an
      // owner-cell assertion would pass on the wrong index and measure nothing.
      labels: [
        { name: 'status:claimed' },
        { name: 'ws:vendor' },
        { name: 'p1' },
      ],
      body: '## Files\nsrc/a.js',
      comments: listedComments,
    }
    const full = {
      ...listed,
      comments: [...listedComments, releaseOf('bravo')],
    }
    const github = FakeGithub({ issues: [listed], viewed: { 800: full } })

    assert.equal(
      ownerOf(full),
      '',
      'sanity: the full timeline really is ownerless',
    )

    const out = await coordOver(github).board()
    const row = out.split('\n').find((l) => l.startsWith('#800'))
    const cells = row.split(/\s{2,}/)

    assert.equal(cells[0], '#800')
    assert.equal(cells[1], 'claimed')
    assert.equal(
      cells[2],
      'vendor',
      'column indexing is what the next assert depends on',
    )
    assert.equal(cells[3], 'p1')
    assert.equal(cells[4], '-', `OWNER column must be empty, got row: ${row}`)
    assert.ok(
      !row.includes('bravo'),
      'a released claimant must not render as owner',
    )
    assert.deepEqual(
      github.calls.viewIssue,
      [800],
      'the seam was traveled for this issue',
    )
  })

  it('refuses a claim whose colliding issue only LOOKS free in the truncated view', async () => {
    const body = '## Files\nsrc/a.js'
    const target = {
      number: 900,
      title: 'mine',
      labels: [],
      body,
      comments: [],
    }
    const rivalComments = [
      ...filler(CEILING - 2),
      claimOf('bravo'),
      releaseOf('bravo'),
    ]
    const listedRival = {
      number: 800,
      title: 'theirs',
      labels: [{ name: 'status:claimed' }],
      body,
      comments: rivalComments,
    }
    const fullRival = {
      ...listedRival,
      comments: [...rivalComments, claimOf('foxtrot')],
    }
    const github = FakeGithub({
      issues: [target, listedRival],
      viewed: { 900: target, 800: fullRival },
    })

    const res = await coordOver(github).claim(900)

    assert.equal(
      res.ok,
      false,
      'the gate must see foxtrot, not an ownerless issue',
    )
    assert.match(res.error, /collides with #800 held by foxtrot/)
    assert.ok(
      github.calls.viewIssue.includes(800),
      'the rival timeline was re-fetched',
    )
    assert.deepEqual(
      github.calls.commentIssue,
      [],
      'no CLAIM comment was posted on a lost gate',
    )
  })

  it('says so out loud when a truncated timeline could not be re-fetched', async () => {
    const github = FakeGithub({
      issues: [hubIssue(filler(CEILING))],
      viewed: {},
    })

    const out = await coordOver(github).sync()

    assert.ok(
      out.includes('only the first 100 comments'),
      'a silent fallback to the truncated array is how the stale tail shipped',
    )
  })
})
