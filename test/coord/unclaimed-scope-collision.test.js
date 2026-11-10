const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { checkScopeCollision, parseScope } = require('../../src/coord/scope')

// #76: the gate's `if (!owner || owner === cleanCurrent) continue` skipped an issue with no CLAIM
// comment out of the collision scan entirely, so two agents could claim the same CONCRETE path in
// the same minute and neither got warned - the pitcairn pair #1171 / #1179 (both open, both
// declaring test/style-debt.mjs, both unclaimed at 2026-11-09T20:30Z) is the live witness. The
// fix makes an unheld overlap RETURN as a warning, never as a refusal: nobody has committed to it,
// and fencing on a bare declaration would freeze exactly the work the board calls free.
//
// The pair below is the whole defect in two calls: identical files, identical claimant, and only
// the presence of a CLAIM line differs. If both arms ever return the same shape, this file is
// lying and should be deleted rather than extended.

const SHARED = 'test/style-debt.mjs'
const TARGET_BODY = `## Files\n${SHARED}\nsrc/x.js`
const PEER_BODY = `## Files\n${SHARED}\npublic/y.css`
const TARGET_FILES = [SHARED, 'src/x.js']
const CLAIM = (agent) =>
  `**CLAIM** | agent: agent-${agent} | human: @Sullux | at: 1794256631855`

const issue = (number, body, comments = [], labels = []) => ({
  number,
  body,
  comments,
  labels,
})
const target = (number = 1171, body = TARGET_BODY) => ({
  number,
  body,
  labels: [],
  comments: [],
})

describe('scope gate #76: an unclaimed open issue with a shared concrete path warns instead of vanishing', () => {
  it('the pair that used to be silent now returns exactly one warning, and still does not refuse', () => {
    const res = checkScopeCollision(
      TARGET_FILES,
      [issue(1179, PEER_BODY)],
      'bravo',
      target(),
    )

    assert.equal(
      res.hasCollision,
      false,
      'an unheld overlap must not fence - nobody owns it yet',
    )
    assert.equal(res.warnings.length, 1, 'and it must not be silent either')
    assert.equal(res.warnings[0].issue, 1179)
    assert.equal(
      res.warnings[0].status,
      'unclaimed',
      'statusOf has no label here, so the fallback names it',
    )
    assert.equal(
      res.warnings[0].agent,
      'nobody',
      'the warning says plainly that no holder exists',
    )
    assert.equal(
      res.warnings[0].unheld,
      true,
      'so a renderer can phrase the advice differently later',
    )
    assert.deepEqual(
      res.warnings[0].files,
      [SHARED],
      'the warning names the shared path, not just the issue',
    )
  })

  it('the IDENTICAL pair with a CLAIM still hard-refuses, which is the arm that makes the one above a measurement', () => {
    const held = issue(1179, PEER_BODY, [{ body: CLAIM('delta') }])
    const res = checkScopeCollision(TARGET_FILES, [held], 'bravo', target())

    assert.equal(
      res.hasCollision,
      true,
      'a held overlap is unchanged: it fences',
    )
    assert.equal(res.collidingIssue, 1179)
    assert.equal(res.collidingAgent, 'delta')
    assert.deepEqual(res.collidingFiles, [SHARED])
  })

  it('non-vacuity floor: a disjoint unclaimed neighbour produces no warning at all', () => {
    const disjoint = issue(
      1179,
      '## Files\npublic/styles/booking.css\nsrc/unrelated.js',
    )
    const res = checkScopeCollision(TARGET_FILES, [disjoint], 'bravo', target())

    assert.equal(
      res.warnings.length,
      0,
      'otherwise every claim would warn and the signal is worthless',
    )
    assert.equal(res.hasCollision, false)
  })

  it('the claiming issue never warns about itself, even though it is unheld by definition', () => {
    // Callers pass the full open set, so the target is usually IN it. With unheld issues now
    // visible, an unguarded loop would make every unclaimed claim warn about its own files.
    const self = issue(1171, TARGET_BODY)
    const res = checkScopeCollision(TARGET_FILES, [self], 'bravo', target())

    assert.equal(res.warnings.length, 0, 'a self-overlap is not a collision')
    assert.equal(res.hasCollision, false)
  })

  it('a split: line waives the unheld pair too, so the existing protocol exit still governs', () => {
    const waiving = target(1171, `## Files\n${SHARED}\nsrc/x.js\nsplit: #1179`)
    const res = checkScopeCollision(
      TARGET_FILES,
      [issue(1179, PEER_BODY)],
      'bravo',
      waiving,
    )

    assert.equal(
      res.warnings.length,
      0,
      'the waiver is declared, so the pair is settled by protocol',
    )
    assert.equal(res.hasCollision, false)
  })

  it('a hard refusal does not swallow the warnings: both halves can fire in one pass', () => {
    const unheld = issue(1179, PEER_BODY)
    const held = issue(
      1170,
      PEER_BODY,
      [{ body: CLAIM('charlie') }],
      [{ name: 'status:claimed' }],
    )
    const res = checkScopeCollision(
      TARGET_FILES,
      [unheld, held],
      'bravo',
      target(),
    )

    assert.equal(res.hasCollision, true, 'the held one still fences')
    assert.equal(res.collidingIssue, 1170)
    assert.equal(
      res.warnings.length,
      1,
      'and the unheld one is still reported rather than lost',
    )
    assert.equal(res.warnings[0].issue, 1179)
  })

  it('glob-vs-concrete stays invisible, deliberately: this issue is the ownerless skip, not #896', () => {
    // Pinned as CURRENT behaviour so a future glob-matching fix is a deliberate edit here instead
    // of a silent widening. Expanding a glob to concrete paths is a different decision and would
    // make every claim warn about every directory-declared issue, which is not this contract.
    const globPeer = issue(1180, '## Files\nsrc/**')
    const res = checkScopeCollision(['src/x.js'], [globPeer], 'bravo', target())

    assert.equal(res.warnings.length, 0)
    assert.ok(
      !parseScope(globPeer.body).includes('src/x.js'),
      'the premise: a glob never matches a concrete path',
    )
  })
})

// The reviewer's gap, and it was a real one: making an overlap visible also made the advice text
// false, because BOTH renderers hardcoded "rebase owed after it merges" - true for an in-review
// neighbour whose merge is pending, untrue for an unclaimed one that may never merge. So these
// arms pin the rendered strings, not just the payload: an advice that travels on the warning but
// is never printed is the same bug in a different hat.

const SHARED_PATH = 'test/style-debt.mjs'

const claimHarness = ({ rivalLabels = [], rivalComments = [] }) => {
  const posted = []
  const out = []
  const targetIssue = {
    number: 1171,
    body: `## Files\n${SHARED_PATH}\nsrc/x.js`,
    labels: [{ name: 'status:unclaimed' }],
    comments: [],
  }
  const rival = {
    number: 1179,
    body: `## Files\n${SHARED_PATH}\npublic/y.css`,
    labels: rivalLabels,
    comments: rivalComments,
  }
  const github = () => ({
    issueKind: async () => ({ isPullRequest: false, state: 'OPEN' }),
    viewIssue: async (num) => (num === 1171 ? targetIssue : rival),
    listIssues: async () => [targetIssue, rival],
    commentIssue: async (num, body) => {
      posted.push(body)
      targetIssue.comments.push({ body })
    },
    editIssue: async () => {},
    closeIssue: async () => {},
  })
  return { posted, out, github }
}

const OLD_FALSE_CLAIM =
  'scope: overlaps in-review work, rebase owed after it merges'

describe('scope gate #77: the advice an overlap carries is the advice an agent reads', () => {
  it('an unheld overlap is rendered as a warning about unclaimed work, not a rebase owed', async () => {
    const { CoordService } = require('../../src/coord')
    const h = claimHarness({})
    const coord = CoordService({
      github: h.github(),
      agent: 'bravo',
      human: 'Sullux',
      now: () => 1700000000000,
    })

    const res = await coord.claim(1171, { plan: 'p', eta: '10m' })
    assert.equal(res.ok, true, 'an unheld overlap must not fence the claim')

    const note = h.posted[0]
    assert.ok(
      note.includes('scope: overlapping open work'),
      'the header names the class, not one status',
    )
    assert.ok(
      !note.includes(OLD_FALSE_CLAIM),
      'the sentence that was untrue for this case is gone',
    )
    const bullet = note.split('\n').find((l) => l.startsWith('- #1179'))
    assert.ok(bullet, 'the rival is named in its own bullet')
    assert.ok(
      bullet.includes('no claim yet'),
      'and the advice matches the actual state',
    )
    assert.ok(
      !bullet.includes('rebase owed'),
      'no merge is promised that may never happen',
    )
    assert.ok(
      bullet.includes('(nobody)'),
      'the holder cell says nobody rather than reading as a holder',
    )
  })

  it('the SAME renderer still says "rebase owed" for an in-review neighbour - the arm that keeps the fix honest', async () => {
    const { CoordService } = require('../../src/coord')
    const h = claimHarness({
      rivalLabels: [{ name: 'status:in-review' }],
      rivalComments: [{ body: '**CLAIM** | agent: agent-delta | at: 1' }],
    })
    const coord = CoordService({
      github: h.github(),
      agent: 'bravo',
      human: 'Sullux',
      now: () => 1700000000000,
    })

    await coord.claim(1171, { plan: 'p', eta: '10m' })
    const bullet = h.posted[0].split('\n').find((l) => l.startsWith('- #1179'))
    assert.ok(
      bullet.includes('rebase owed after it merges (status:in-review)'),
      `the true case must survive: ${bullet}`,
    )
    assert.ok(
      !bullet.includes('no claim yet'),
      'and delta is not described as absent',
    )
    assert.ok(bullet.includes('(delta)'), 'the holder names itself')
  })

  it('the CLI line an agent actually reads carries the same advice, and drops the false clause', async () => {
    const { Cli } = require('../../src/cli')
    const { CoordService } = require('../../src/coord')
    const h = claimHarness({})
    const out = []
    const cli = Cli({
      github: { repo: 'Sullux/pi-agents' },
      coordFactory: ({ agent }) =>
        CoordService({
          github: {
            ...h.github(),
            viewIssue: async (num) =>
              num === 1171
                ? { ...(await h.github().viewIssue(1171)) }
                : h.github().viewIssue(1179),
          },
          agent,
          human: 'Sullux',
          now: () => 1700000000000,
        }),
      provenance: { describe: () => '', note: () => '' },
      stdout: (line) => out.push(line),
      stderr: () => {},
    })

    const code = await cli.run(['coord', 'claim', '1171'])
    assert.equal(code, 0, 'the claim succeeds')
    const line = out.find((l) => l.startsWith('  ! overlaps'))
    assert.ok(line, `the warning reaches stdout: ${JSON.stringify(out)}`)
    assert.ok(
      line.includes('(unclaimed, nobody)'),
      'status and holder are both stated',
    )
    assert.ok(
      line.includes('no claim yet'),
      'and the advice is the truthful one',
    )
    assert.ok(
      !line.includes('rebase after it merges'),
      'the old hardcoded clause is gone from the CLI too',
    )
  })
})

// #83: `unheld` was doing double duty for "nobody has this" and "someone clearly has this, and the
// comment that would prove it is missing". The second one got the sentence "claim it first if you
// mean to own it" while a PR was open against it - the gate was right to warn and wrong about what
// the warning meant. Measured live: pitcairn #1180 / #1182 / #1187 all sat labelled with zero
// parseable CLAIM lines, two of them with an open PR.

const adviceOf = async (rivalLabels, rivalComments = []) => {
  const h = claimHarness({ rivalLabels, rivalComments })
  const { CoordService } = require('../../src/coord')
  const coord = CoordService({
    github: h.github(),
    agent: 'bravo',
    human: 'Sullux',
    now: () => 1700000000000,
  })
  const res = await coord.claim(1171, { plan: 'p', eta: '10m' })
  return {
    res,
    advice: res.warnings?.[0]?.advice,
    bullet: h.posted[0]?.split('\n').find((l) => l.startsWith('- #1179')),
  }
}

describe('scope gate #83: held-but-unattributable is not the same advice as free', () => {
  it('a rival labelled status:claimed with no CLAIM line is told to read the thread, not to claim it', async () => {
    const { res, advice, bullet } = await adviceOf([{ name: 'status:claimed' }])
    assert.equal(res.ok, true, 'advice text does not fence anything')
    assert.ok(advice, 'the warning carries advice')
    assert.match(advice, /do not claim it blind/)
    assert.ok(
      !/claim it first/.test(advice),
      'the invitation to claim a held issue is gone',
    )
    assert.ok(
      advice.includes('labelled claimed'),
      `the label is echoed, not guessed: ${advice}`,
    )
    assert.match(
      bullet,
      /do not claim it blind/,
      'and the RENDERED bullet says it too',
    )
  })

  it('every held label reaches the same branch, including one written by a human in mixed case', async () => {
    for (const [label, note] of [
      ['status:in-progress', 'a live edit'],
      ['status:blocked', 'parked work'],
      [
        'status:Claimed',
        'case-folded by #78, so the fold is load-bearing here',
      ],
    ]) {
      const { advice } = await adviceOf([{ name: label }])
      assert.match(
        advice || '',
        /do not claim it blind/,
        `${label} (${note}) got: ${advice}`,
      )
      assert.ok(
        !/claim it first/.test(advice || ''),
        `${label} must not invite a blind claim`,
      )
    }
  })

  it('a genuinely free rival keeps the old sentence - the fix must not swallow the true case', async () => {
    for (const labels of [[], [{ name: 'status:unclaimed' }]]) {
      const { advice } = await adviceOf(labels)
      assert.match(
        advice || '',
        /no claim yet/,
        `free issue ${JSON.stringify(labels)}: ${advice}`,
      )
      assert.ok(
        !/do not claim it blind/.test(advice || ''),
        'and it is NOT described as held',
      )
    }
  })

  it('a held rival WITH a parseable CLAIM still gets the rebase sentence, unchanged', async () => {
    const { advice } = await adviceOf(
      [{ name: 'status:in-review' }],
      [{ body: '**CLAIM** | agent: agent-delta | at: 1' }],
    )
    assert.match(
      advice || '',
      /rebase owed after it merges \(status:in-review\)/,
    )
    assert.ok(
      !/do not claim it blind/.test(advice || ''),
      'owner is derivable, so this is not the #83 case',
    )
  })
})

// #102, the gate half of the same incident: with the OLD fold these four live bytes produced
// `{ hasCollision: false, warnings: [{ soft: true, agent: 'nobody', ... }] }` - a fresh agent
// reaching for AGENTS.md got an ADVISORY against a file bravo held under an uncontested earliest
// claim. Restating the fixture here (not only in owner-parse.test.js) is the point: the fold is
// allowed to be right about ownership while the gate still fails to fence on it, and #76's whole
// lesson was that a lost `if (!owner) continue` skip is only visible from the caller's side.

describe('#102: the live #1218 timeline is a HARD fence for every other agent', () => {
  const CLAIM_B = {
    body: '**CLAIM** | agent: agent-bravo | human: @Sullux | at: 1794269072270\n\nscope: overlapping open work\n- #1213 (charlie) on AGENTS.md - rebase owed after it merges (status:in-review)\n- #1208 (alpha) on AGENTS.md - rebase owed after it merges (status:in-review)',
  }
  const CLAIM_A = {
    body: '**CLAIM** | agent: agent-alpha | human: @Sullux | at: 1794269083651\n\nplan: branch: docs/1218-merge-tree-discriminator\n\nscope: overlapping open work\n- #1213 (charlie) on AGENTS.md - rebase owed after it merges (status:in-review)',
  }
  const REL_A1 = {
    body: '**RELEASE** | agent: agent-alpha | reason: lost claim race to bravo',
  }
  const REL_A2 = {
    body: '**RELEASE** | agent: agent-alpha | reason: LOST the simultaneous race - bravo CLAIM stamped 00:04:32Z, mine 00:04:44Z, earliest wins per Rule C. Standing down clean so ownerOf-last-word does not mis-show me as holder. 00:05:05Z',
  }

  it('a later claimant gets a refusal naming the earliest holder, and zero soft warnings', () => {
    const held = issue(
      1218,
      '## Files\nAGENTS.md',
      [CLAIM_B, CLAIM_A, REL_A1, REL_A2],
      [{ name: 'status:claimed' }],
    )
    const res = checkScopeCollision(
      ['AGENTS.md'],
      [held],
      'echo',
      target(999999, '## Files\nAGENTS.md'),
    )
    assert.equal(
      res.hasCollision,
      true,
      `the earliest claim must fence the file, not advise: ${JSON.stringify(res)}`,
    )
    assert.equal(res.collidingAgent, 'bravo')
    assert.equal(res.collidingIssue, 1218)
    assert.deepEqual(
      res.warnings,
      [],
      'no soft pass-through: `agent: nobody` + soft was the measured hole, and its absence is half the proof',
    )
  })

  it('and bravo re-reaching their OWN issue is still waved through by the owner-match', () => {
    const held = issue(
      1218,
      '## Files\nAGENTS.md',
      [CLAIM_B, CLAIM_A, REL_A1, REL_A2],
      [],
    )
    const res = checkScopeCollision(
      ['AGENTS.md'],
      [held],
      'bravo',
      target(999999, '## Files\nAGENTS.md'),
    )
    assert.equal(
      res.hasCollision,
      false,
      'self-collision is exempt - precedence does not lock the holder out of their own scope',
    )
  })
})
