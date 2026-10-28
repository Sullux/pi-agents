const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Cli } = require('../../src/cli/index.js')
const { GitHubClient } = require('../../src/github/index.js')

// #23: `Marked #21 done` does not say WHICH #21. Both Sullux repos carry low, overlapping numbers -
// each has a #21 and a #23 - and GitHubClient resolves the target as --repo -> COORD_REPO -> the cwd's
// origin remote. Following the checkout you stand in is correct behavior; the defect was that the
// output never named it, so a session in a pitcairn worktree meaning a pi-agents issue mutated the
// same number in the wrong repo silently. Measured on myself at 06:17 UTC: `coord done 21` closed
// pitcairn #21 and posted a bogus DONE citing a pi-agents PR number.
//
// The target is appended as an END-OF-LINE suffix, which is measured rather than cosmetic: the inline
// form first proposed in the issue (`Marked Sullux/pi-agents#21 done`) breaks `/Claimed #999999/` and
// `/Posted to hub #\d+/`, and loosening three unrelated pins to fund a wording change is a bad trade.

const okCoord = {
  claim: async () => ({ ok: true, warnings: [] }),
  release: async () => ({ ok: true }),
  status: async () => ({ ok: true }),
  review: async () => ({ ok: true }),
  done: async () => ({ ok: true }),
  hub: async () => ({ ok: true, hubNumber: 4 }),
  board: async () => 'BOARD',
  sync: async () => 'SYNC',
}

const harness = (repo) => {
  const out = []
  const err = []
  const cli = Cli({
    github: { repo },
    coordFactory: () => okCoord,
    provenance: { describe: () => 'DESCRIBE', note: () => '' },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  })
  return { out, err, run: (argv) => cli.run(argv) }
}

describe('every mutating verb names the resolved repo (#23)', () => {
  const cases = [
    [['coord', 'claim', '21'], 'Claimed #21 @Sullux/pi-agents'],
    [['coord', 'release', '21'], 'Released #21 @Sullux/pi-agents'],
    [
      ['coord', 'status', '21', 'still going'],
      'Status updated on #21 @Sullux/pi-agents',
    ],
    [
      ['coord', 'review', '21', 'verdict', '--pr', '9'],
      'Moved #21 to in-review @Sullux/pi-agents',
    ],
    [['coord', 'done', '21', '--pr', '9'], 'Marked #21 done @Sullux/pi-agents'],
    [['coord', 'hub', 'a note'], 'Posted to hub #4 @Sullux/pi-agents'],
  ]

  for (const [argv, line] of cases) {
    it(`${argv[1]} ends its success line with the target`, async () => {
      const h = harness('Sullux/pi-agents')
      assert.equal(await h.run(argv), 0)
      const hit = h.out.filter((l) => l === line)
      assert.equal(
        hit.length,
        1,
        `expected exactly one ${line}, got: ${h.out.join(' | ')}`,
      )
      assert.ok(
        hit[0].endsWith('@Sullux/pi-agents'),
        'the target must be the last token',
      )
      assert.equal(h.err.join(''), '')
    })
  }

  it('a different target produces a different line (the suffix is not decoration)', async () => {
    const h = harness('Sullux/pitcairn-portal')
    assert.equal(await h.run(['coord', 'claim', '21']), 0)
    assert.ok(
      h.out.includes('Claimed #21 @Sullux/pitcairn-portal'),
      h.out.join(' | '),
    )
  })
})

describe('the unresolved case is named, not hidden (#23)', () => {
  it('prints @unresolved when nothing resolves a repo', async () => {
    const h = harness('')
    assert.equal(await h.run(['coord', 'claim', '21']), 0)
    assert.ok(
      h.out.includes('Claimed #21 @unresolved (gh cwd default)'),
      h.out.join(' | '),
    )
  })
})

describe('read-only verbs keep their own shape (#23 guard cannot spread)', () => {
  for (const [verb, text] of [
    ['board', 'BOARD'],
    ['sync', 'SYNC'],
  ]) {
    it(`${verb} prints the service output with no target suffix`, async () => {
      const h = harness('Sullux/pi-agents')
      assert.equal(await h.run(['coord', verb]), 0)
      assert.equal(h.out.join('\n'), text)
    })
  }

  it('provenance names the coord target a verb would act on', async () => {
    const h = harness('Sullux/pi-agents')
    assert.equal(await h.run(['coord', 'provenance']), 0)
    assert.match(h.out.join('\n'), /^coord repo {2}Sullux\/pi-agents$/m)
    assert.ok(
      h.out.join('\n').includes('DESCRIBE'),
      '#18 readout must stay intact',
    )
  })
})

describe('GitHubClient resolution order (#23)', () => {
  const remoteUrl = 'git@github.com:Sullux/from-remote.git\n'
  const asGit = (url) => (_cmd, args) => {
    if (args[0] === 'remote') return url
    throw new Error(`unexpected spawn: ${args.join(' ')}`)
  }

  const withEnv = (value, body) => {
    const had = 'COORD_REPO' in process.env
    const previous = process.env.COORD_REPO
    if (value === undefined) delete process.env.COORD_REPO
    else process.env.COORD_REPO = value
    try {
      return body()
    } finally {
      if (had) process.env.COORD_REPO = previous
      else delete process.env.COORD_REPO
    }
  }

  it('--repo wins over the env and the remote', () =>
    withEnv('Sullux/env-repo', () => {
      const github = GitHubClient({
        repo: 'Sullux/flag-repo',
        execFile: asGit(remoteUrl),
      })
      assert.equal(github.repo, 'Sullux/flag-repo')
    }))

  it('COORD_REPO beats the cwd remote', () =>
    withEnv('Sullux/env-repo', () => {
      assert.equal(
        GitHubClient({ execFile: asGit(remoteUrl) }).repo,
        'Sullux/env-repo',
      )
    }))

  it('the cwd origin remote is the fallback', () =>
    withEnv(undefined, () => {
      assert.equal(
        GitHubClient({ execFile: asGit(remoteUrl) }).repo,
        'Sullux/from-remote',
      )
    }))

  it('a failed remote read resolves to no repo at all', () =>
    withEnv(undefined, () => {
      const github = GitHubClient({
        execFile: () => {
          throw new Error('not a git repository')
        },
      })
      assert.equal(github.repo, '')
    }))
})
