const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const {
  checkBacklogAvailability,
  isPrAuthoredByAgent,
  isPrReviewedByAgent,
  prReviewGap,
  VERDICT_MARKERS,
  scanUnattestedClosures,
} = require('../../src/runner/preflight')

describe('Runner: Backlog Preflight', () => {
  it('returns ready if agent owns an active claimed issue', async () => {
    const issues = [
      {
        number: 10,
        labels: [{ name: 'status:claimed' }],
        comments: [{ body: '**CLAIM** | agent: agent-alpha' }],
      },
    ]
    const github = {
      listIssues: async () => issues,
      listPrs: async () => [],
    }

    const res = await checkBacklogAvailability({ github, agent: 'alpha' })
    assert.equal(res.status, 'ready')
    assert.equal(res.reason, 'owned_claims')
  })

  it('does not count status:in-review issues as active owned_claims', async () => {
    const issues = [
      {
        number: 10,
        labels: [{ name: 'status:claimed' }, { name: 'status:in-review' }],
        comments: [{ body: '**CLAIM** | agent: agent-alpha' }],
      },
    ]
    const github = {
      listIssues: async () => issues,
      listPrs: async () => [],
    }

    const res = await checkBacklogAvailability({ github, agent: 'alpha' })
    assert.equal(res.status, 'idle_busy')
    assert.equal(res.waitSeconds, 60)
  })

  it('returns unclaimed_tasks when owned claims are in-review but unclaimed tasks exist', async () => {
    const issues = [
      {
        number: 10,
        labels: [{ name: 'status:claimed' }, { name: 'status:in-review' }],
        comments: [{ body: '**CLAIM** | agent: agent-alpha' }],
      },
      {
        number: 11,
        labels: [{ name: 'status:unclaimed' }, { name: 'type:task' }],
        comments: [],
      },
    ]
    const github = {
      listIssues: async () => issues,
      listPrs: async () => [],
    }

    const res = await checkBacklogAvailability({ github, agent: 'alpha' })
    assert.equal(res.status, 'ready')
    assert.equal(res.reason, 'unclaimed_tasks')
  })

  it('returns ready if actionable unclaimed issues exist', async () => {
    const issues = [
      {
        number: 20,
        labels: [{ name: 'status:unclaimed' }, { name: 'type:task' }],
        comments: [],
      },
    ]
    const github = {
      listIssues: async () => issues,
      listPrs: async () => [],
    }

    const res = await checkBacklogAvailability({ github, agent: 'alpha' })
    assert.equal(res.status, 'ready')
    assert.equal(res.reason, 'unclaimed_tasks')
  })

  it('returns ready if open PRs exist and have not been reviewed by agent', async () => {
    const issues = [
      {
        number: 20,
        labels: [{ name: 'status:claimed' }],
        comments: [{ body: '**CLAIM** | agent: bravo' }],
      },
    ]
    const github = {
      listIssues: async () => issues,
      listPrs: async () => [{ number: 100, headRefOid: 'abc1234567' }],
    }

    const res = await checkBacklogAvailability({ github, agent: 'alpha' })
    assert.equal(res.status, 'ready')
    assert.equal(res.reason, 'open_prs')
    assert.equal(res.count, 1)
  })

  it('returns idle_busy when all open PRs are already reviewed by this agent', async () => {
    const issues = [
      {
        number: 20,
        labels: [{ name: 'status:claimed' }],
        comments: [{ body: '**CLAIM** | agent: bravo' }],
      },
    ]
    const github = {
      listIssues: async () => issues,
      listPrs: async () => [
        {
          number: 100,
          headRefOid: 'abc1234567890',
          comments: [
            {
              body: '**REVIEW** | agent: agent-alpha | verdict: **APPROVE** | head: `abc1234`',
            },
          ],
        },
      ],
    }

    const res = await checkBacklogAvailability({ github, agent: 'alpha' })
    assert.equal(res.status, 'idle_busy')
    assert.equal(res.reason, 'peer_contention')
    assert.equal(res.waitSeconds, 60)
  })

  it('returns ready open_prs when a PR head moved after this agent reviewed an older commit', async () => {
    const issues = [
      {
        number: 20,
        labels: [{ name: 'status:claimed' }],
        comments: [{ body: '**CLAIM** | agent: bravo' }],
      },
    ]
    const github = {
      listIssues: async () => issues,
      listPrs: async () => [
        {
          number: 100,
          headRefOid: 'def5678901234',
          comments: [
            {
              body: '**REVIEW** | agent: agent-alpha | verdict: **APPROVE** | head: `abc1234`',
            },
          ],
        },
      ],
    }

    const res = await checkBacklogAvailability({ github, agent: 'alpha' })
    assert.equal(res.status, 'ready')
    assert.equal(res.reason, 'open_prs')
    assert.equal(res.count, 1)
  })

  it('returns idle_busy when the only open PR is authored by this agent', async () => {
    const issues = [
      {
        number: 20,
        labels: [{ name: 'status:claimed' }, { name: 'status:in-review' }],
        comments: [{ body: '**CLAIM** | agent: agent-alpha' }],
      },
    ]
    const github = {
      listIssues: async () => issues,
      listPrs: async () => [
        {
          number: 100,
          headRefName: 'fix/20-my-feature',
          closingIssuesReferences: [{ number: 20 }],
        },
      ],
    }

    const res = await checkBacklogAvailability({ github, agent: 'alpha' })
    assert.equal(res.status, 'idle_busy')
    assert.equal(res.reason, 'peer_contention')
  })

  it('returns idle_busy when all issues are claimed by peers and 0 PRs', async () => {
    const issues = [
      {
        number: 30,
        labels: [{ name: 'status:claimed' }],
        comments: [{ body: '**CLAIM** | agent: bravo' }],
      },
    ]
    const github = {
      listIssues: async () => issues,
      listPrs: async () => [],
    }

    const res = await checkBacklogAvailability({ github, agent: 'alpha' })
    assert.equal(res.status, 'idle_busy')
    assert.equal(res.waitSeconds, 60)
  })

  it('returns idle_empty when 0 non-hub issues exist', async () => {
    const issues = [
      {
        number: 4,
        labels: [{ name: 'hub' }],
        comments: [],
      },
    ]
    const github = {
      listIssues: async () => issues,
      listPrs: async () => [],
    }

    const res = await checkBacklogAvailability({ github, agent: 'alpha' })
    assert.equal(res.status, 'idle_empty')
    assert.equal(res.waitSeconds, 300)
  })
})

describe('Runner: PR Authorship and Review Helpers', () => {
  it('isPrAuthoredByAgent detects authorship via comments, branch, or closing ref', () => {
    const myIssues = [{ number: 50 }]
    assert.equal(
      isPrAuthoredByAgent(
        { closingIssuesReferences: [{ number: 50 }] },
        'delta',
        myIssues,
      ),
      true,
    )
    assert.equal(
      isPrAuthoredByAgent(
        { headRefName: 'fix/50-something' },
        'delta',
        myIssues,
      ),
      true,
    )
    assert.equal(
      isPrAuthoredByAgent(
        { comments: [{ body: '(agent-delta, the author)' }] },
        'delta',
        [],
      ),
      true,
    )
    assert.equal(
      isPrAuthoredByAgent({ headRefName: 'fix/99-other' }, 'delta', myIssues),
      false,
    )
  })

  it('isPrReviewedByAgent detects reviews and retractions citing shortSha', () => {
    const pr = {
      headRefOid: 'dcc9637e5ebc2d284750c2b384de993cd9e057a5',
      comments: [
        {
          body: '**RETRACTION of my two APPROVEs** | agent: agent-delta | head `dcc9637` | at: 2026-10-28T16:30:15Z',
        },
      ],
    }
    assert.equal(isPrReviewedByAgent(pr, 'delta'), true)
    assert.equal(isPrReviewedByAgent(pr, 'echo'), false)
  })
})

// #90: the matcher answers a yes/no question, and `checkBacklogAvailability` read every `false` as "go
// review this" - including the falses caused by an unsigned verdict or a moved head. The allowlist stays
// closed (a head-cited witness is not a verdict; that follows from the caller's `reviewablePrs` filter,
// which asks "is a verdict owed?", not "has anyone attested?"), so the cause is named instead. Both live
// bodies below are byte-copied from real threads, because #89's gap stayed invisible while every fixture
// described a shape the tool never emits.
describe('Runner: #90 review-gap causes, named instead of widened', () => {
  // Live bytes: PR #84's thread, agent-charlie's attestation of one acceptance box.
  const CHARLIE_WITNESS =
    '**NON-SELF WITNESS for box 5** | agent: agent-charlie | measured at `a029d24810314ee042b0235f2ab0c495bfd27d3f`'
  // Live bytes: the retraction shape the arm above already carries - note `head` with NO colon, which is
  // why HEAD_CITED_RE cannot require one.
  const DELTA_RETRACTION =
    '**RETRACTION of my two APPROVEs** | agent: agent-delta | head `dcc9637` | at: 2026-10-28T16:30:15Z'
  // The shape #88 wrote before #89: signed header, no head token anywhere in the body.
  const UNSIGNED_VERDICT =
    '**REVIEW** | agent: agent-alpha | verdict: APPROVE | at: 1794264219372'

  const prAt = (sha, bodies) => ({
    number: 84,
    headRefOid: sha,
    comments: bodies.map((body) => ({ body })),
  })

  it('a head-cited attestation with a non-protocol marker is an attestation, not a verdict', () => {
    const pr = prAt('a029d24810314ee042b0235f2ab0c495bfd27d3f', [
      CHARLIE_WITNESS,
    ])
    assert.equal(isPrReviewedByAgent(pr, 'echo'), false)
    const gap = prReviewGap(pr, 'echo')
    assert.equal(gap.gap, 'non-verdict-attestation')
    assert.match(gap.hint, /NON-SELF WITNESS for box 5/)
    assert.match(gap.hint, /charlie/)
    assert.match(gap.hint, /verdict is still owed/)
  })

  it('the attester themself is told a verdict is owed, not that they already reviewed it', () => {
    const pr = prAt('a029d24810314ee042b0235f2ab0c495bfd27d3f', [
      CHARLIE_WITNESS,
    ])
    assert.equal(prReviewGap(pr, 'charlie').gap, 'non-verdict-attestation')
  })

  it('a verdict citing a head that moved reads STALE, and the hint carries both SHAs', () => {
    const pr = prAt('9f3c1d2aaaa5b1c2d3e4f50617283940aabbccdd', [
      DELTA_RETRACTION,
    ])
    assert.equal(isPrReviewedByAgent(pr, 'delta'), false)
    const gap = prReviewGap(pr, 'delta')
    assert.equal(gap.gap, 'stale-head-verdict')
    assert.match(gap.hint, /`dcc9637`/)
    assert.match(gap.hint, /`9f3c1d2`/)
  })

  it('the same live retraction at its own current head reads reviewed, not stale', () => {
    const pr = prAt('dcc9637e5ebc2d284750c2b384de993cd9e057a5', [
      DELTA_RETRACTION,
    ])
    assert.equal(isPrReviewedByAgent(pr, 'delta'), true)
    assert.equal(prReviewGap(pr, 'delta').gap, 'reviewed')
  })

  it('a verdict signed with no head token reads unsigned, and names the verb that fixes it', () => {
    const pr = prAt('13b0ee90e7fbd0e867303ea4fb84a41f446568d8', [
      UNSIGNED_VERDICT,
    ])
    assert.equal(isPrReviewedByAgent(pr, 'alpha'), false)
    const gap = prReviewGap(pr, 'alpha')
    assert.equal(gap.gap, 'unsigned-verdict')
    assert.match(gap.hint, /no head token/)
    assert.match(gap.hint, /page coord review <issue> --pr 84/)
  })

  it('an empty thread reads unreviewed - the one case where the old advice was right', () => {
    const pr = prAt('13b0ee90e7fbd0e867303ea4fb84a41f446568d8', [])
    assert.equal(prReviewGap(pr, 'echo').gap, 'unreviewed')
  })

  it('no identity is UNMEASURED, never a silent "nobody reviewed this"', () => {
    const pr = prAt('13b0ee90e7fbd0e867303ea4fb84a41f446568d8', [
      CHARLIE_WITNESS,
    ])
    assert.equal(prReviewGap(pr, '').gap, 'unmeasured')
  })

  it('the verb list is ONE list: every marker matches, and WITNESS is not among them', () => {
    const sha = 'abcdef0123456789abcdef0123456789abcdef01'
    VERDICT_MARKERS.forEach((marker) => {
      const pr = prAt(sha, [
        `**${marker} of the earlier pass** | agent: agent-echo | head \`${sha.slice(0, 7)}\``,
      ])
      assert.equal(
        isPrReviewedByAgent(pr, 'echo'),
        true,
        `${marker} must match`,
      )
      assert.equal(prReviewGap(pr, 'echo').gap, 'reviewed', `${marker} gap`)
    })
    const witness = prAt(sha, [
      `**WITNESS for box 2** | agent: agent-echo | head \`${sha.slice(0, 7)}\``,
    ])
    assert.equal(isPrReviewedByAgent(witness, 'echo'), false)
    assert.equal(prReviewGap(witness, 'echo').gap, 'non-verdict-attestation')
  })

  it('the join, per fixture: the gap says "reviewed" on exactly the threads the matcher accepts', () => {
    const cases = [
      ['a029d24810314ee042b0235f2ab0c495bfd27d3f', CHARLIE_WITNESS, 'echo'],
      ['9f3c1d2aaaa5b1c2d3e4f50617283940aabbccdd', DELTA_RETRACTION, 'delta'],
      ['13b0ee90e7fbd0e867303ea4fb84a41f446568d8', UNSIGNED_VERDICT, 'alpha'],
      ['dcc9637e5ebc2d284750c2b384de993cd9e057a5', DELTA_RETRACTION, 'delta'],
      ['dcc9637e5ebc2d284750c2b384de993cd9e057a5', CHARLIE_WITNESS, 'echo'],
    ]
    cases.forEach(([sha, body, agent]) => {
      const pr = prAt(sha, [body])
      assert.equal(
        prReviewGap(pr, agent).gap === 'reviewed',
        isPrReviewedByAgent(pr, agent),
        `classifier and matcher disagreed at ${sha.slice(0, 7)} for ${agent}`,
      )
    })
  })

  it('checkBacklogAvailability carries the cause per PR, one entry per counted PR', async () => {
    const issues = [
      {
        number: 20,
        labels: [{ name: 'status:claimed' }],
        comments: [{ body: '**CLAIM** | agent: bravo' }],
      },
    ]
    const github = {
      listIssues: async () => issues,
      listPrs: async () => [
        prAt('a029d24810314ee042b0235f2ab0c495bfd27d3f', [CHARLIE_WITNESS]),
        {
          number: 91,
          headRefOid: '13b0ee90e7fbd0e867303ea4fb84a41f446568d8',
          comments: [{ body: UNSIGNED_VERDICT }],
        },
        {
          number: 7,
          headRefOid: 'eeeeeee5ebc2d284750c2b384de993cd9e057a5',
          comments: [],
        },
      ],
    }

    const res = await checkBacklogAvailability({ github, agent: 'alpha' })
    assert.equal(res.reason, 'open_prs')
    assert.equal(res.reviewGaps.length, res.count)
    assert.deepEqual(
      res.reviewGaps.map((g) => [g.number, g.gap]),
      [
        [84, 'non-verdict-attestation'],
        [91, 'unsigned-verdict'],
        [7, 'unreviewed'],
      ],
    )
  })

  // #93: two bodies differing by ONE appended sentence. Arm A is the fired-proof that the currency matcher
  // engaged at all - if the fixture were invisible to the matcher both arms would read `unreviewed`, which is a
  // harness bug wearing a green result (the issue's own first attempt hit exactly that with `agent: pi/charlie`,
  // which matches no verdict header). Arm B is the defect: a sha written in prose flips a stale verdict to
  // "reviewed" under a bare `includes(shortSha)`.
  const CURRENT_HEAD = 'f3e6adff5c1b2d3e4f5a6b7c8d9e0f1a2b3c4d5e'
  const STALE_VERDICT =
    '**REVIEW** | agent: agent-charlie | verdict: APPROVE | head `aaa0d12`'
  const MOVED_PROSE =
    'Main has since moved to f3e6adf, so re-measure before merging.'

  it('arm A (fired-proof): a verdict naming a dead head is stale, no prose involved', () => {
    const pr = prAt(CURRENT_HEAD, [
      `${STALE_VERDICT}\n\nls-remote == headRefOid == aaa0d12.`,
    ])
    assert.equal(isPrReviewedByAgent(pr, 'charlie'), false)
    assert.equal(prReviewGap(pr, 'charlie').gap, 'stale-head-verdict')
  })

  it('arm B: the same verdict plus a PROSE mention of the new head stays stale (#93)', () => {
    const pr = prAt(CURRENT_HEAD, [
      `${STALE_VERDICT}\n\nls-remote == headRefOid == aaa0d12.\n\n${MOVED_PROSE}`,
    ])
    assert.equal(
      isPrReviewedByAgent(pr, 'charlie'),
      false,
      'a sha inside a sentence is not the head attested',
    )
    const gap = prReviewGap(pr, 'charlie')
    assert.equal(gap.gap, 'stale-head-verdict')
    assert.match(
      gap.hint,
      /`aaa0d12`/,
      'the hint must name the attested head, not the one quoted in prose',
    )
  })

  it('a verdict naming NO head keeps the substring read (#93 box 2, the fallback)', () => {
    // Pre-#89 hand-shaped attestations carry no token the writer produced. Requiring one would newly report a
    // hundred correctly-reviewed threads as unreviewed - the false-negative direction, work vanishing off the
    // board. This arm is the pin that clause is deliberate: if someone drops the fallback the second assert
    // reddens while the first stays green.
    const namesCurrent = `**REVIEW** | agent: agent-charlie | verdict: APPROVE | measured at ${CURRENT_HEAD.slice(0, 7)} on top of 91aaeee`
    assert.equal(
      isPrReviewedByAgent(prAt(CURRENT_HEAD, [namesCurrent]), 'charlie'),
      true,
    )
    assert.equal(
      prReviewGap(prAt(CURRENT_HEAD, [namesCurrent]), 'charlie').gap,
      'reviewed',
    )
    const namesOther =
      '**REVIEW** | agent: agent-charlie | verdict: APPROVE | measured at 91aaeee'
    assert.equal(
      isPrReviewedByAgent(prAt(CURRENT_HEAD, [namesOther]), 'charlie'),
      false,
      'the fallback is a substring read, not a pass',
    )
  })

  it('the witness site is currency-checked too - the third includes(shortSha)', () => {
    // The regex takes the FIRST head token, so the attested (stale) head leads and the current sha sits in
    // prose after it: under the old substring read this witness looked current and produced
    // `non-verdict-attestation`; under the named-head rule it is evidence about an older tree and the thread
    // is simply still owed a verdict.
    const staleWitness = `**NON-SELF WITNESS for box 5** | agent: agent-charlie | head \`a029d24\` | ${MOVED_PROSE}`
    assert.equal(
      prReviewGap(prAt(CURRENT_HEAD, [staleWitness]), 'charlie').gap,
      'unreviewed',
    )
    // positive control: the same witness naming the CURRENT head still reads as the attestation it is
    const liveWitness = `**NON-SELF WITNESS for box 5** | agent: agent-charlie | head \`${CURRENT_HEAD.slice(0, 7)}\``
    assert.equal(
      prReviewGap(prAt(CURRENT_HEAD, [liveWitness]), 'charlie').gap,
      'non-verdict-attestation',
    )
  })
})
// #99: the reporting half of #94. These arms exist because the scan's whole job is to distinguish "nothing
// unattested" from "the read could not answer", and because it found two closures (#93, #53) that a
// hand-run audit of the same night missed - so the fixture set encodes the shapes the fleet actually writes.
const CLOSE_BODY_UNTICKED = [
  '## Goal',
  '',
  'Ship the thing.',
  '',
  '## Done when',
  '',
  '- [ ] first criterion, not measured',
  '- [ ] second criterion, not measured',
].join('\n')

const CLOSE_BODY_TICKED = [
  '## Done when',
  '',
  '- [x] first criterion measured at 42/42',
  '- [x] second criterion measured on main',
].join('\n')

const CLOSE_BODY_NUMBERED = [
  '## Done when',
  '',
  '1. a numbered criterion, which has no tick mechanism at all',
  '2. another numbered criterion',
].join('\n')

const CLOSE_BODY_MIXED = [
  '## Done when',
  '',
  '- [x] one measured',
  '- [ ] one outstanding',
].join('\n')

const HOUR = 60 * 60 * 1000
const NOW = Date.parse('2026-11-10T00:00:00Z')
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z')

describe('Runner: unattested-closure scan (#99)', () => {
  const closedAtInside = iso(NOW - 2 * HOUR)
  const closedAtOutside = iso(NOW - 40 * HOUR)

  const makeGithub = (rows) => {
    const calls = []
    return {
      calls,
      listIssues: async (options = {}) => {
        calls.push(options.state || 'open')
        return (options.state || 'open') === 'closed' ? rows : []
      },
      listPrs: async () => [],
    }
  }

  it('reports a closed-with-unticked issue and NOT the other three shapes', async () => {
    const rows = [
      { number: 1, closedAt: closedAtInside, body: CLOSE_BODY_UNTICKED },
      { number: 2, closedAt: closedAtInside, body: CLOSE_BODY_TICKED },
      { number: 3, closedAt: closedAtInside, body: CLOSE_BODY_NUMBERED },
    ]
    const github = makeGithub(rows)
    const res = await scanUnattestedClosures({ github, now: () => NOW })
    // the filter must be shown to FIRE, not merely to have not crashed
    assert.equal(res.unattested.length, 1, 'exactly one shape is unattested')
    assert.equal(res.unattested[0].number, 1)
    assert.equal(res.unattested[0].unticked, 2)
    assert.equal(res.unattested[0].boxes, 2)
    assert.ok(
      !res.unattested.some((u) => u.number === 2),
      'a fully ticked close is clean',
    )
    assert.ok(
      !res.unattested.some((u) => u.number === 3),
      'a numbered Done-when is not attestable',
    )
    assert.deepEqual(
      github.calls,
      ['closed'],
      'the scan reads the closed axis only',
    )
  })

  it('never reports an OPEN issue, because an open one cannot be an unattested close', async () => {
    // shape (d) of the selectivity bar: the unticked-boxes-without-a-close case must not appear, which the
    // scan guarantees by asking for state closed - so the open row is absent from the fixture it is handed.
    const rows = [
      { number: 5, closedAt: closedAtInside, body: CLOSE_BODY_UNTICKED },
    ]
    const res = await scanUnattestedClosures({
      github: makeGithub(rows),
      now: () => NOW,
    })
    const openIssue = { number: 9, body: CLOSE_BODY_UNTICKED }
    assert.equal(res.unattested.length, 1)
    assert.ok(
      !res.unattested.some((u) => u.number === openIssue.number),
      'an open issue is outside this population by construction',
    )
  })

  it('applies the window and NAMES it, so a bounded read is not mistaken for the whole history', async () => {
    const rows = [
      { number: 11, closedAt: closedAtInside, body: CLOSE_BODY_MIXED },
      { number: 12, closedAt: closedAtOutside, body: CLOSE_BODY_UNTICKED },
    ]
    const res = await scanUnattestedClosures({
      github: makeGithub(rows),
      now: () => NOW,
    })
    assert.equal(res.inWindow, 1, 'the 40h-old close is outside the 6h window')
    assert.deepEqual(
      res.unattested.map((u) => u.number),
      [11],
    )
    assert.ok(
      res.note.includes('last 6h'),
      `window stated in output: ${res.note}`,
    )
    assert.equal(res.windowHours, 6)
    const wide = await scanUnattestedClosures({
      github: makeGithub(rows),
      now: () => NOW,
      windowHours: 48,
    })
    assert.equal(
      wide.inWindow,
      2,
      'widening the window reaches the older close',
    )
    assert.ok(
      wide.note.includes('last 48h'),
      'the stated window follows the parameter',
    )
  })

  it('prints the population it examined on a clean sweep, so zero is not confused with blindness', async () => {
    const rows = [
      { number: 21, closedAt: closedAtInside, body: CLOSE_BODY_TICKED },
    ]
    const res = await scanUnattestedClosures({
      github: makeGithub(rows),
      now: () => NOW,
    })
    assert.equal(res.unattested.length, 0)
    assert.ok(res.note.includes('1 closed issue(s) scanned'), res.note)
    assert.ok(res.note.includes('1 closed within the last 6h'), res.note)
    assert.ok(res.note.includes('0 unattested'), res.note)
  })

  it('reports UNKNOWN rather than a confident zero when the read fails', async () => {
    const github = {
      listIssues: async () => {
        throw new Error('returned exactly 500 issues so the set is TRUNCATED')
      },
      listPrs: async () => [],
    }
    const res = await scanUnattestedClosures({ github, now: () => NOW })
    assert.equal(res.readable, false)
    assert.equal(res.scanned, 0)
    assert.ok(res.note.includes('UNKNOWN'), res.note)
    assert.ok(res.note.includes('CLOSED axis'), res.note)
    assert.ok(
      !/\b0 unattested\b/.test(res.note),
      `a failed read must not print a clean count: ${res.note}`,
    )
  })

  it('caps the listed names but says how many were dropped, newest first', async () => {
    const rows = [1, 2, 3, 4, 5].map((n) => ({
      number: n,
      closedAt: iso(NOW - n * HOUR),
      body: CLOSE_BODY_UNTICKED,
    }))
    const res = await scanUnattestedClosures({
      github: makeGithub(rows),
      now: () => NOW,
    })
    assert.equal(res.unattested.length, 5)
    assert.ok(res.note.includes('(+2 more, newest first)'), res.note)
    assert.ok(res.note.includes('#1 '), 'the newest close is listed first')
    assert.ok(
      !res.note.includes('#5 '),
      'the oldest is inside the dropped count, not silently gone',
    )
  })

  it('treats a row with no closedAt as outside the window, and still names the population', async () => {
    // the shape a dropped `closedAt` select produces: the read succeeds, every closure is invisible to the
    // window, and a bare count would read as a clean repo. The scanned number must survive to say so.
    const rows = [{ number: 41, body: CLOSE_BODY_UNTICKED }]
    const res = await scanUnattestedClosures({
      github: makeGithub(rows),
      now: () => NOW,
    })
    assert.equal(res.readable, true)
    assert.equal(
      res.inWindow,
      0,
      'no closedAt means no window membership can be claimed',
    )
    assert.equal(res.unattested.length, 0)
    assert.ok(res.note.includes('1 closed issue(s) scanned'), res.note)
    assert.ok(res.note.includes('0 closed within the last 6h'), res.note)
  })

  it('attaches the report to every dispatch-ready path so the agent actually sees it', async () => {
    const closed = [
      { number: 31, closedAt: closedAtInside, body: CLOSE_BODY_UNTICKED },
    ]
    const build = (openIssues) => ({
      listIssues: async (options = {}) =>
        (options.state || 'open') === 'closed' ? closed : openIssues,
      listPrs: async () => [],
    })
    const unclaimed = await checkBacklogAvailability({
      github: build([{ number: 40, labels: [], comments: [], body: '' }]),
      agent: 'alpha',
      now: () => NOW,
    })
    assert.equal(unclaimed.status, 'ready')
    assert.ok(
      unclaimed.closures?.note.includes('#31'),
      'unclaimed_tasks carries the scan',
    )
    const owned = await checkBacklogAvailability({
      github: build([
        {
          number: 41,
          labels: [{ name: 'status:claimed' }],
          comments: [{ body: '**CLAIM** | agent: agent-alpha' }],
        },
      ]),
      agent: 'alpha',
      now: () => NOW,
    })
    assert.equal(owned.reason, 'owned_claims')
    assert.ok(
      owned.closures?.note.includes('#31'),
      'owned_claims carries the scan too',
    )
  })

  it('leaves the empty-backlog path alone - no scan, no claim of cleanliness', async () => {
    const res = await checkBacklogAvailability({
      github: { listIssues: async () => [], listPrs: async () => [] },
      agent: 'alpha',
      now: () => NOW,
    })
    assert.equal(res.status, 'idle_empty')
    assert.equal(
      res.closures,
      undefined,
      'the scan did not run, so nothing is asserted about closures',
    )
  })
})
