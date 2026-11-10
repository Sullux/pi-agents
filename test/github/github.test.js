const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const {
  GitHubClient,
  resolveRepoFromRemote,
  GH_MAX_BUFFER,
  NODE_DEFAULT_MAX_BUFFER,
} = require('../../src/github')

describe('GitHubClient', () => {
  it('resolveRepoFromRemote parses SSH, HTTPS, and git suffix URLs', () => {
    assert.equal(
      resolveRepoFromRemote('git@github.com:Sullux/pitcairn-portal.git'),
      'Sullux/pitcairn-portal',
    )
    assert.equal(
      resolveRepoFromRemote('https://github.com/Sullux/pitcairn-portal.git'),
      'Sullux/pitcairn-portal',
    )
    assert.equal(
      resolveRepoFromRemote('https://github.com/Sullux/pitcairn-portal'),
      'Sullux/pitcairn-portal',
    )
  })

  it('listIssues executes gh issue list with correct json flags', async () => {
    let capturedArgs = []
    const mockExec = (cmd, args) => {
      capturedArgs = [cmd, ...args]
      return JSON.stringify([{ number: 1, title: 'test issue' }])
    }

    const client = GitHubClient({
      execFile: mockExec,
      repo: 'Sullux/pitcairn-portal',
    })
    const issues = await client.listIssues()

    assert.equal(issues.length, 1)
    assert.equal(issues[0].title, 'test issue')
    assert.equal(capturedArgs[0], 'gh')
    assert.ok(capturedArgs.includes('--repo'))
    assert.ok(capturedArgs.includes('Sullux/pitcairn-portal'))
    // #99: the closed-window scan is only as good as the fields this call selects. Dropping `closedAt`
    // makes every real closure read `undefined`, which the window filter then drops - a false "0
    // unattested" that no other arm can see, because every fixture already carries the key by hand.
    const jsonArg = capturedArgs[capturedArgs.indexOf('--json') + 1]
    const fields = jsonArg.split(',')
    for (const f of ['number', 'body', 'closedAt']) {
      assert.ok(
        fields.includes(f),
        `listIssues must select ${f}: got ${jsonArg}`,
      )
    }
  })

  it('#106: issueKind asks gh api for state and stateReason in the SAME payload as kind', async () => {
    // The service's CLOSED guard reads `kind?.state`, so the jq projection is the load-bearing
    // line in the REAL call - a coord-test double can carry the field by hand forever while the
    // live API answer drops it, which is the mock-only false-green this file already pins for
    // listIssues above. This arm fires on the argv STRING, not on a fixture.
    let capturedArgs = []
    const mockExec = (cmd, args) => {
      capturedArgs = [cmd, ...args]
      // #126: this fixture used to answer `state: 'CLOSED'` - which is what GraphQL returns and what
      // REST does NOT. The fiction is exactly why the inert compare survived review: the mock carried
      // by hand the value the guard compares, while `gh api` emits it lowercase. Now sends the real
      // bytes, so this arm guards the normalization as well as the jq projection it was written for.
      return JSON.stringify({
        isPullRequest: false,
        state: 'closed',
        stateReason: 'completed',
        title: 'an issue',
        body: '',
      })
    }
    const client = GitHubClient({
      execFile: mockExec,
      repo: 'Sullux/pi-agents',
    })
    const kind = await client.issueKind(4)
    assert.equal(
      kind.state,
      'CLOSED',
      'the parsed payload keeps the field the guard branches on',
    )
    assert.equal(
      kind.stateReason,
      'COMPLETED',
      'and the reason the refusal message prints',
    )
    assert.equal(capturedArgs[0], 'gh')
    const jq = capturedArgs[capturedArgs.indexOf('--jq') + 1]
    for (const select of [
      'state: .state',
      'stateReason: .state_reason',
      '(.pull_request != null)',
    ]) {
      assert.ok(
        jq.includes(select),
        `issueKind jq must project ${select}: got ${jq}`,
      )
    }
  })
})

// The pitcairn coordination hub (issue #4) grew to 1,051,909 bytes across 783 comments. Node's
// execFileSync default maxBuffer is 1,048,576, and exceeding it THROWS ENOBUFS rather than
// truncating - so `page coord board` died outright for every agent on the box, including the
// viewIssue re-fetch that withFullTimelines performs precisely to avoid a truncated timeline.
const HUB_PAYLOAD_BYTES = 1051909

describe('gh output buffering', () => {
  it('passes a maxBuffer above the Node default on every child process it spawns', async () => {
    const options = []
    const mockExec = (cmd, args, opts) => {
      options.push([cmd, opts])
      return cmd === 'git' ? 'git@github.com:Sullux/pitcairn-portal.git' : '[]'
    }

    const client = GitHubClient({ execFile: mockExec })
    await client.listIssues()

    // Both spawn sites, not just the gh one: the git-remote probe is small today but shares the
    // helper, and a pin on one site only would let the other regress silently.
    assert.ok(
      options.length >= 1,
      `expected a spawn, captured ${options.length}`,
    )
    for (const [cmd, opts] of options) {
      assert.equal(
        opts?.maxBuffer,
        GH_MAX_BUFFER,
        `${cmd} was spawned without the raised maxBuffer - it would ENOBUFS past 1MB`,
      )
    }
    assert.ok(
      GH_MAX_BUFFER > NODE_DEFAULT_MAX_BUFFER,
      'the raised ceiling must actually exceed the default it replaces',
    )
    assert.ok(
      GH_MAX_BUFFER > HUB_PAYLOAD_BYTES,
      'the ceiling must clear the payload that broke it',
    )
  })

  it('the default really does throw at the hub payload size, and the raised ceiling does not', () => {
    const emit = [
      '-e',
      `process.stdout.write('x'.repeat(${HUB_PAYLOAD_BYTES}))`,
    ]

    // RED arm: reproduces the production failure at the production byte count. Without this the
    // constant above is an unexercised number.
    let threw = ''
    try {
      execFileSync('node', emit, { encoding: 'utf8' })
    } catch (e) {
      threw = e.code || e.message
    }
    assert.equal(
      threw,
      'ENOBUFS',
      'the 1MB default must fail at 1,051,909 bytes or this pins nothing',
    )

    // GREEN arm: the same payload through the shipped constant.
    const out = execFileSync('node', emit, {
      encoding: 'utf8',
      maxBuffer: GH_MAX_BUFFER,
    })
    assert.equal(
      out.length,
      HUB_PAYLOAD_BYTES,
      'the full payload must arrive, not a truncated prefix',
    )
  })
})

describe('#126 kind casing and the per-issue timeline read', () => {
  const clientFor = (reply) =>
    GitHubClient({
      repo: 'Sullux/pi-agents',
      execFile: () => reply,
    })

  it('issueKind answers in ONE casing whatever the transport sends', async () => {
    // REST says `closed`, GraphQL says `CLOSED`. The client is the thing that promised a contract,
    // so the normalization belongs here and every consumer inherits a working compare.
    for (const wire of ['closed', 'CLOSED', 'Closed']) {
      const client = clientFor(
        JSON.stringify({
          isPullRequest: false,
          state: wire,
          stateReason: 'completed',
        }),
      )
      const kind = await client.issueKind(94)
      assert.equal(
        kind.state,
        'CLOSED',
        `wire value ${JSON.stringify(wire)} must reach the guard as CLOSED`,
      )
      assert.equal(
        kind.stateReason,
        'COMPLETED',
        'and the reason field likewise',
      )
    }
  })

  it('the exact compare src/coord refuses on now matches a REST-shaped reply', async () => {
    // This is the arm that would have been RED before the fix. Written as the consumer writes it -
    // `kind?.state === 'CLOSED'` is the only CLOSED check in src/coord/index.js - so a future
    // change to either side that breaks the guard reddens here rather than landing inert.
    const kind = await clientFor(
      JSON.stringify({
        isPullRequest: false,
        state: 'closed',
        stateReason: 'completed',
        title: 'an issue',
        body: '',
      }),
    ).issueKind(94)
    assert.equal(
      kind?.state === 'CLOSED',
      true,
      'refuseIfNotOpen would have allowed a write onto a CLOSED target',
    )
  })

  it('issueKind still answers undefined when the read fails - #118 owns that half', async () => {
    // Deliberate: the fail-open path is #118's, and it needs src/coord/index.js (alpha's #124 is
    // editing it) plus the fixture re-pin in delta's #121. Pinned unchanged so nobody reads my
    // casing edit as that fix, and so a later throw-on-error change reddens HERE first.
    const client = GitHubClient({
      repo: 'Sullux/pi-agents',
      execFile: () => {
        throw new Error('gh: HTTP 502')
      },
    })
    assert.equal(await client.issueKind(94), undefined)
  })

  it('issueTimeline is exported, paginates inside one issue, and flattens', async () => {
    const seen = []
    const client = GitHubClient({
      repo: 'Sullux/pi-agents',
      execFile: (cmd, args) => {
        seen.push([cmd, ...args].join(' '))
        return [
          JSON.stringify({ event: 'commented', created_at: 'a' }),
          JSON.stringify({ event: 'closed', created_at: 'b', commit_id: null }),
        ].join('\n')
      },
    })
    assert.equal(typeof client.issueTimeline, 'function')
    const events = await client.issueTimeline(94)
    assert.equal(events.length, 2, 'two streamed objects are two events')
    assert.deepEqual(
      events.map((e) => e.event),
      ['commented', 'closed'],
    )
    assert.match(seen[0], /repos\/Sullux\/pi-agents\/issues\/94\/timeline/)
    assert.match(seen[0], /--paginate/)
    // `.[]` not `.[-1]`: a per-page filter returns page one's tail and reads as "nothing happened"
    // (the recorded gh --paginate false negative). Pin the shape that flattens.
    assert.match(seen[0], /--jq \.\[\]$/)
  })

  it('issueTimeline refuses a malformed event instead of reporting an empty timeline', async () => {
    const client = clientFor('{"event":"labeled"}\nnot json at all')
    await assert.rejects(
      () => client.issueTimeline(94),
      /event 2 of 2 is not JSON/,
    )
  })

  it('issueTimeline treats a truly empty timeline as a result, not a failure', async () => {
    assert.deepEqual(await clientFor('').issueTimeline(1), [])
  })

  it('issueTimeline caps its own per-issue fan-out, loudly', async () => {
    const one = JSON.stringify({ event: 'subscribed' })
    const client = clientFor(Array(2001).fill(one).join('\n'))
    await assert.rejects(
      () => client.issueTimeline(94),
      /above the 2000 per-issue ceiling/,
    )
  })
})
