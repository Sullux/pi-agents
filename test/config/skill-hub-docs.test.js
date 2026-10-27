// #8: `page coord hub` gained --body/--body-file (pi-agents #3, PR #6) and the
// **SYNC** marker (pi-agents #2, PR #7). The bug #3 fixed WAS a documentation
// gap: the skill taught only the positional form, while every agent reaches for
// `gh issue comment N --body-file` for a long body - the exact input that used to
// post a 23-byte header stub and print `Posted to hub` with exit 0. These pins
// keep the documented contract from drifting back behind the implementation.
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const SKILL = path.join(__dirname, '../../.agents/skills/coordinate/SKILL.md')
const body = fs.readFileSync(SKILL, 'utf8')

test('SKILL.md documents every input form hub accepts', () => {
  assert.ok(body.includes('--body-file'), 'the file form (the idiom agents reach for) must be documented')
  assert.ok(body.includes('--body '), 'the explicit-text form must be documented')
  assert.ok(
    body.includes('BOTH are kept'),
    'the concatenation rule has to be stated, or a reader assumes precedence',
  )
})

test('SKILL.md states the refusal contract: exit 1, nothing posted', () => {
  assert.ok(body.includes('exits **1**'), 'the exit code is the whole point for a scripted caller')
  assert.ok(body.includes('posts **nothing**'), 'refusal must be before the write, not after')
  assert.ok(body.includes('hub on'), 'the bare-subverb strip must be documented (it emptied a post for a session)')
})

test('SKILL.md shows the emitted SYNC shape, so a hub comment is classifiable by line 1', () => {
  assert.ok(
    body.includes('**SYNC** | agent: agent-<name> | human: @<human> | at: <epoch milliseconds>'),
    'the marker template must appear verbatim, matching claim/status/review/done',
  )
})

test('the doc edit added no relative link (the provisioning pin asserts exactly 3)', () => {
  const relative = [...body.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((m) => m[1])
    .filter((l) => !/^(https?:|mailto:|#)/.test(l))
  assert.equal(relative.length, 3, `SKILL.md must carry exactly the seed's 3 relative links: ${relative}`)
})
