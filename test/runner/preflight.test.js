const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const {
  checkBacklogAvailability,
  isPrAuthoredByAgent,
  isPrReviewedByAgent,
  prReviewGap,
  VERDICT_MARKERS,
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
