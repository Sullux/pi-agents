const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { CoordService } = require('../../src/coord')
const { CoordTaxonomy } = require('../../src/coord/taxonomy')

// #79: pi-agents carries only GitHub's nine defaults, so `status:claimed` does not exist here and
// every verb's label write is a call that cannot succeed. #34 made that failure LOUD and best-effort
// (correct: a silent `Claimed` is a lie), and this file pins the narrow improvement on top - skip the
// doomed call, say the true thing - without softening #34 for repos that do have the taxonomy.
//
// The asymmetry that drives the design: failing OPEN (write anyway) can only cost a doomed API call,
// while failing SHUT (cache a probe error as "label-less") would silently stop moving labels in a repo
// that really has them. Every fail-open arm below exists to keep that direction honest.
const GH_DEFAULTS = [
  'bug',
  'documentation',
  'enhancement',
  'invalid',
  'question',
  'wontfix',
]
const WITH_STATUS = ['bug', 'status:claimed', 'status:in-review']
const asObjects = (names) => names.map((name) => ({ name }))

const build = ({ taxonomy, seam = true, fail = false } = {}) => {
  const calls = { edit: [], comment: [], listLabels: 0 }
  const issue = {
    number: 34,
    title: 'T',
    body: '## Files\nsrc/foo.js\n\n## Goal\nT',
    labels: asObjects(WITH_STATUS),
    comments: [],
  }
  const github = {
    issueKind: async () => ({ isPullRequest: false, state: 'OPEN' }),
    viewIssue: async () => ({
      ...issue,
      comments: [{ body: '**CLAIM** | agent: foxtrot | at: 1700000000000' }],
    }),
    listIssues: async () => [issue],
    commentIssue: async (number, body) => {
      calls.comment.push([number, body])
    },
    closeIssue: async () => {},
    editIssue: async (number, edits) => {
      calls.edit.push([number, edits])
      if (fail) throw new Error("'status:claimed' not found")
    },
  }
  if (seam) {
    github.listLabels = async () => {
      calls.listLabels += 1
      if (taxonomy === 'throw') throw new Error('gh label list failed')
      return taxonomy
    }
  }
  return {
    calls,
    coord: CoordService({
      github,
      agent: 'foxtrot',
      human: 'Sullux',
      now: () => 1700000000000,
    }),
  }
}

describe('#79: a repo with no status: labels skips the doomed write and says so', () => {
  it('claim: zero label calls, the comment still lands, the notice is returned', async () => {
    const { coord, calls } = build({ taxonomy: asObjects(GH_DEFAULTS) })
    const res = await coord.claim(34, { plan: 'branch: x' })
    assert.equal(
      calls.edit.length,
      0,
      'the whole point is that no gh issue edit is attempted: ' +
        JSON.stringify(calls.edit),
    )
    assert.equal(
      calls.comment.length,
      1,
      '#34 stays intact: the comment IS the record',
    )
    assert.match(res.labelNotice, /no status: labels/)
    assert.equal(
      res.labelWarning,
      undefined,
      'a skipped write is not a failed write - it must not borrow the warning field',
    )
    assert.equal(res.ok, true, 'the verb still succeeded')
  })

  it('a repo that HAS status: labels still gets its real write (conditional, not blanket)', async () => {
    const { coord, calls } = build({ taxonomy: asObjects(WITH_STATUS) })
    const res = await coord.claim(34, { plan: 'branch: x' })
    assert.equal(
      calls.edit.length,
      1,
      'the taxonomy exists, so the write must happen',
    )
    assert.deepEqual(calls.edit[0][1].addLabels, ['status:claimed'])
    assert.equal(res.labelNotice, undefined)
  })

  it('a double with no listLabels seam writes anyway (fail-open for every existing test)', async () => {
    const { coord, calls } = build({ seam: false })
    const res = await coord.claim(34, { plan: 'branch: x' })
    assert.equal(
      calls.edit.length,
      1,
      'an unreadable taxonomy is UNKNOWN, not label-less - the old behavior stands',
    )
    assert.equal(res.labelNotice, undefined)
  })

  it('a listLabels failure is never cached as label-less (the worse bug, kept impossible)', async () => {
    const { coord, calls } = build({ taxonomy: 'throw' })
    await coord.claim(34, { plan: 'a' })
    await coord.release(34, { reason: 'b' })
    assert.equal(
      calls.edit.length,
      2,
      'both verbs still wrote labels after a failed probe',
    )
    assert.equal(
      calls.listLabels,
      2,
      'the probe RETRIES rather than freezing on a transient error',
    )
  })

  it('a successful probe is cached: one taxonomy read per service instance, not one per write', async () => {
    const { coord, calls } = build({ taxonomy: asObjects(GH_DEFAULTS) })
    await coord.claim(34, { plan: 'a' })
    await coord.release(34, { reason: 'b' })
    assert.equal(
      calls.listLabels,
      1,
      'the point of the probe is fewer calls, not more',
    )
    assert.equal(calls.edit.length, 0, 'and both writes were still skipped')
  })

  it('a failed write in a repo that HAS the taxonomy still returns labelWarning (#34 unsoftened)', async () => {
    const { coord, calls } = build({
      taxonomy: asObjects(WITH_STATUS),
      fail: true,
    })
    const res = await coord.claim(34, { plan: 'a' })
    assert.equal(calls.edit.length, 1)
    assert.match(
      res.labelWarning,
      /not found/,
      '#34 still quotes gh, exactly as pinned',
    )
    assert.equal(res.labelNotice, undefined)
  })
})

describe('#79: CoordTaxonomy reads both label shapes and folds case', () => {
  const probeWith = (github) => CoordTaxonomy({ github })

  it('detects the status family through object labels, string labels, and mixed case', async () => {
    const rows = [
      [{ name: 'status:claimed' }],
      ['status:claimed'],
      [{ name: 'Status:Claimed' }],
    ]
    for (const taxonomy of rows) {
      const t = probeWith({ listLabels: async () => taxonomy })
      assert.equal(
        await t.labelWriteIsMeaningless(),
        false,
        `a real status label must disable the skip: ${JSON.stringify(taxonomy)}`,
      )
    }
  })

  it('a taxonomy with hub but no status family is label-less (the pi-agents shape)', async () => {
    const t = probeWith({
      listLabels: async () => [{ name: 'hub' }, { name: 'bug' }],
    })
    assert.equal(await t.labelWriteIsMeaningless(), true)
  })

  it('unknown is never true: no seam and a thrown read both answer "write anyway"', async () => {
    assert.equal(await probeWith({}).labelWriteIsMeaningless(), false)
    assert.equal(
      await probeWith({
        listLabels: async () => {
          throw new Error('down')
        },
      }).labelWriteIsMeaningless(),
      false,
    )
  })
})
