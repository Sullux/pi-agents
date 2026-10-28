const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Cli } = require('../../src/cli')
const { CoordService } = require('../../src/coord')

// pi-agents#31. `page coord done <issue> [--pr <n>] "<attestation>"` printed
// `Marked #N done`, exited 0, and posted a HEADER-ONLY **DONE** line: the service has
// always rendered `text` (`(text ? `\n\n${text}` : '')`), but the CLI's `done` branch
// called `coord.done(num.value, { pr: flags.pr })` and read nothing from
// `positionals.slice(2)`. `review` and `status`, a few lines above it, both require or
// forward that positional - which is what made the shape so easy to believe.
//
// Measured on the fleet, not in the abstract: my own verification table for
// pitcairn#1135 (998/998 lane, two discrimination arms, content greps on main) vanished
// into a 62-byte header, and my first published explanation of WHY blamed the issue
// already being closed. It was unconditional.
//
// These arms drive the real CoordService over a mock github, because the defect lived
// in the wiring between the two: a service-only arm already passed at the broken tip,
// and a fake-coord arm could never see the body at all.
describe('page coord done carries its message (#31)', () => {
  const harness = () => {
    const posted = []
    const edited = []
    const closed = []
    const out = []
    const err = []
    const cli = Cli({
      github: { repo: 'Sullux/pi-agents' },
      coordFactory: ({ agent }) =>
        CoordService({
          github: {
            commentIssue: async (num, body) => posted.push({ num, body }),
            viewIssue: async () => ({
              number: 21,
              labels: [{ name: 'status:claimed' }],
              comments: [],
              body: '',
            }),
            editIssue: async (num, edits) => edited.push({ num, edits }),
            closeIssue: async (num) => closed.push(num),
          },
          agent,
          human: 'Sullux',
          now: () => 1700000000000,
        }),
      provenance: { describe: () => '', note: () => '' },
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    })
    return {
      cli,
      posted,
      edited,
      closed,
      out,
      err,
      run: (argv) => cli.run(['coord', 'done', ...argv]),
    }
  }

  it('a trailing message reaches the DONE comment body', async () => {
    const h = harness()
    const message = 'shipped at abc1234, lane 5/5'
    assert.equal(await h.run(['21', '--pr', '9', message]), 0)
    assert.equal(
      h.posted.length,
      1,
      'exactly one comment: the header alone is the bug',
    )
    const body = h.posted[0].body
    assert.ok(body.startsWith('**DONE**'), body)
    assert.ok(body.includes(message), body)
    // criterion 3 of the issue: the blank line between header and payload is what every
    // downstream protocol parser survives on, so it is pinned rather than argued.
    assert.ok(body.includes('\n\n' + message), body)
    assert.ok(
      h.out.some(
        (l) =>
          l ===
          `Attached ${message.length}-character message to the DONE comment`,
      ),
      h.out.join(' | '),
    )
  })

  // criterion 4: attaching a payload must not silently change what a DONE means to the
  // ownership resolver. A characterization arm - green on both sides of the fix by
  // design - whose value is catching a future change to the header shape.
  it('a message-bearing DONE still de-owns the issue in ownerOf', async () => {
    const { ownerOf } = require('../../src/coord/owner')
    const h = harness()
    assert.equal(await h.run(['21', 'full attestation with a long body']), 0)
    const done = h.posted[0].body
    const holder = done.match(/agent: (agent-\S+)/)?.[1]
    assert.ok(holder, `no agent named in the header: ${done}`)
    const mine = `**CLAIM** | agent: ${holder}`
    assert.equal(
      ownerOf({ comments: [{ body: mine }] }),
      holder.replace(/^agent-/, ''),
      'sanity floor: a claim must resolve before the de-own means anything',
    )
    assert.equal(
      ownerOf({ comments: [{ body: mine }, { body: done }] }),
      '',
      'the DONE line must still terminate the claim with a body under it',
    )
  })

  // The header-only case has to stay readable AS header-only, or the notice is
  // decoration: with no message there is nothing to have lost.
  it('no message posts the header alone and claims nothing', async () => {
    const h = harness()
    assert.equal(await h.run(['21', '--pr', '9']), 0)
    assert.equal(h.posted.length, 1)
    assert.ok(h.posted[0].body.startsWith('**DONE**'))
    assert.ok(!h.posted[0].body.includes('\n\n'), h.posted[0].body)
    assert.equal(
      h.out.filter((l) => l.startsWith('Attached ')).length,
      0,
      h.out.join(' | '),
    )
  })

  // #23 pinned the success line byte-for-byte across every mutating verb, and chose an
  // end-of-line suffix precisely so unrelated pins would not need loosening. The
  // message notice therefore gets its OWN line, and this is the arm that keeps it that way.
  it('the success line stays byte-identical when a message is attached', async () => {
    const h = harness()
    assert.equal(await h.run(['21', 'the verdict text']), 0)
    assert.equal(
      h.out.filter((l) => l === 'Marked #21 done @Sullux/pi-agents').length,
      1,
      h.out.join(' | '),
    )
    assert.equal(h.out.length, 2, h.out.join(' | '))
    assert.equal(h.err.join(''), '')
  })

  it('the PR number and the message survive in the same comment', async () => {
    const h = harness()
    assert.equal(await h.run(['21', '--pr', '44', 'merged as deadbeef']), 0)
    const body = h.posted[0].body
    assert.ok(body.includes('pr: #44'), body)
    assert.ok(body.includes('merged as deadbeef'), body)
    assert.ok(
      body.indexOf('pr: #44') < body.indexOf('merged as deadbeef'),
      "the header line stays first so ownerOf's ^**DONE** anchor still resolves",
    )
  })

  // The message arrives as one or more positionals; a `join(' ')` that silently kept
  // only the last would still satisfy arm 1 if that arm passed a single argument.
  it('multi-word text is joined, not truncated to the last positional', async () => {
    const h = harness()
    assert.equal(await h.run(['21', 'line one', 'line two']), 0)
    assert.ok(h.posted[0].body.includes('line one line two'), h.posted[0].body)
  })

  // An explicitly empty payload must not manufacture a notice, mirroring the `hub`
  // guard (#3) where an empty body still produced a well-formed header the API accepted.
  it('an empty quoted message is header-only, with no false notice', async () => {
    const h = harness()
    assert.equal(await h.run(['21', '--pr', '9', '']), 0)
    assert.equal(h.posted.length, 1)
    assert.ok(!h.posted[0].body.includes('\n\n'), h.posted[0].body)
    assert.equal(h.out.filter((l) => l.startsWith('Attached ')).length, 0)
  })

  // The payload fix must not turn `done` into a comment-only verb: closing and
  // de-labelling are what the board reads.
  it('attaching a message does not skip the close or the label strip', async () => {
    const h = harness()
    assert.equal(await h.run(['21', 'full attestation goes here']), 0)
    assert.deepEqual(h.closed, [21])
    assert.equal(h.edited.length, 1)
    assert.deepEqual(h.edited[0].edits.removeLabels, ['status:claimed'])
  })

  it('a non-numeric issue is still refused before any write', async () => {
    const h = harness()
    assert.equal(await h.run(['not-a-number', 'a message']), 1)
    assert.equal(h.posted.length, 0)
    assert.equal(h.closed.length, 0)
  })
})
