const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const {
  GitHubClient,
  resolveRepoFromRemote,
  isKindReadFailure,
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

  it('#118: a failed read THROWS a tagged failure instead of answering undefined', async () => {
    // This arm pinned the OPPOSITE until #118 landed - `assert.equal(await client.issueKind(94),
    // undefined)` with a comment promising the fail-open path was #118's to fix. The two facts are
    // now separated at the source: a read that FAILED throws and cannot be mistaken for a payload,
    // while a read that SUCCEEDED with no `state` answers normally and is refused by the guard.
    // The tag matters as much as the throw: a caller distinguishing "the artifact is gone" from "I
    // could not look" reads `isKindReadFailure`, not a message string.
    const client = GitHubClient({
      repo: 'Sullux/pi-agents',
      execFile: () => {
        throw new Error('gh: HTTP 502')
      },
    })
    const settled = await client.issueKind(94).then(
      (value) => ({ resolved: value }),
      (error) => ({ error }),
    )
    assert.equal(
      settled.resolved,
      undefined,
      'a failed read must not resolve to a value that `kind?.state` can read as open',
    )
    const err = settled.error
    assert.ok(
      isKindReadFailure(err),
      `the throw must be tagged, got: ${err?.message}`,
    )
    assert.equal(
      err.number,
      94,
      'and it carries the number it could not resolve',
    )
    assert.match(
      err.message,
      /HTTP 502/,
      'the transport error is quoted, so the operator can act on the cause',
    )
  })

  it('#118: unparsable stdout is the same class as a transport error', async () => {
    // `gh api` can answer a rate-limit page or an empty body, and the old single `catch` folded that
    // into the same `undefined` as a dropped socket - so "the parse broke" and "there is no network"
    // were one value. Both now throw the tagged failure; the reason string keeps them distinct.
    for (const [label, stdout] of [
      ['an HTML error page', '<html>Server Error</html>'],
      ['an empty body', ''],
    ]) {
      const err = await GitHubClient({
        repo: 'Sullux/pi-agents',
        execFile: () => stdout,
      })
        .issueKind(94)
        .catch((error) => error)
      assert.ok(
        isKindReadFailure(err),
        `${label} must be a tagged read failure, got: ${JSON.stringify(err)?.slice(0, 80)}`,
      )
      assert.ok(
        `${err.reason}`.length > 0,
        `${label} must name its own cause, so the operator retries the right thing`,
      )
    }
  })

  it('#118 ask 2 (review): a read that SUCCEEDS with no `state` still resolves - the third case, driven', async () => {
    // The PR's whole claim is that "the read failed" and "the object carries no state" are different
    // facts, and the first two had arms while the third - the one that keeps `upper()`'s normalization
    // honest - had none on the real client. A double that throws proves only that CoordService
    // propagates; this drives the actual exec seam with a payload that is readable and stateless.
    // Discrimination: make `state: undefined` a throw and THIS arm reddens while the two above stay
    // green, which is the selectivity that makes the pair of throw arms mean something.
    const client = GitHubClient({
      repo: 'Sullux/pi-agents',
      execFile: () =>
        '{"isPullRequest":false,"state_reason":null,"title":"t","body":"b"}',
    })
    const kind = await client.issueKind(94)
    assert.ok(
      kind && !kind.isPullRequest,
      'a readable object answers, it does not reject',
    )
    assert.equal(
      kind.state,
      undefined,
      'a payload with no `state` key answers `state: undefined` - readable, not failed',
    )
    assert.equal(
      kind.stateReason,
      undefined,
      '`upper()` passes a missing field through instead of inventing one',
    )
    assert.equal(
      isKindReadFailure(kind),
      false,
      'and the guard cannot mistake it for a read that failed',
    )
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
