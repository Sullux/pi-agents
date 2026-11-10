// #141: repo hygiene. Two pins, both behavioral:
// 1. the exact ignore-rule list, asserted with SET EQUALITY (a padded or silently-dropped rule
//    is invisible to `includes`-style checks), and
// 2. the ANCHORING itself - the pitcairn lesson is that an unanchored `tmp/` reaches prettier's
//    ignore set and silences style checking for temp fixture directories (PR #1256's first commit
//    broke six pins this way). Existence of a rule is not the contract; which paths it matches is.
// The fired-proof drives the real `git check-ignore` against git's own semantics through a
// temporary secondary git repo (a per-test private dir, never this repo's working tree - the
// #855/#909 shared-substrate lesson), because asserting only the text would pass on bytes git
// interprets differently than the comment claims.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { readFileSync, rmSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const IGNORE_PATH = join(__dirname, '..', '.gitignore')
const EXPECTED_RULES = [
  'node_modules',
  '/tmp/',
  '/dist/',
  '/test-results/',
  '/playwright-report/',
  '/.pi-metrics.json',
  '/.pi-processes.json',
  '/.pi/',
]

// Pure text classify: which expected rules are missing from an ignore file's content.
// Exported semantics: a missing rule is named, not counted.
const missingRules = (text) => {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
  return EXPECTED_RULES.filter((r) => !lines.includes(r))
}

const checkIgnore = (dir, path) => {
  try {
    execFileSync('git', ['-C', dir, 'check-ignore', path], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

describe('#141 repo hygiene: the ignore file carries its own provenance', () => {
  it('the live .gitignore has exactly the expected rules - set equality both directions', () => {
    const text = readFileSync(IGNORE_PATH, 'utf8')
    assert.deepEqual(missingRules(text), [], 'no expected rule may be gone')
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
    const extra = lines.filter((l) => !EXPECTED_RULES.includes(l))
    assert.deepEqual(extra, [], 'no unannounced rule may be added either - a padded list hides a broadened match')
  })

  it('FIRED-PROOF: deleting one rule makes the classifier name exactly that rule', () => {
    const text = readFileSync(IGNORE_PATH, 'utf8')
    const neutered = text
      .split('\n')
      .filter((l) => l.trim() !== '/tmp/')
      .join('\n')
    const lost = missingRules(neutered)
    assert.deepEqual(lost, ['/tmp/'], 'the guard must name the missing rule, not merely disagree')
  })

  it('git itself agrees with the anchoring semantics the comment promises: root tmp/ ignored, nested src/tmp/ NOT', () => {
    // A private throwaway repo so this never touches the fleet's working trees; a fresh repo
    // has an empty ignore set, so any divergence below is this file's bytes, not history.
    const dir = join(tmpdir(), `hygiene-${process.pid}-`)
    mkdirSync(dir, { recursive: true })
    try {
      const git = (args) =>
        execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' })
      git(['init', '-q'])
      const text = readFileSync(IGNORE_PATH, 'utf8')
      // write the rules under test AND a tracked sentinel so status has meaning in the repo
      require('node:fs').writeFileSync(join(dir, '.gitignore'), text)
      mkdirSync(join(dir, 'tmp'), { recursive: true })
      mkdirSync(join(dir, 'src', 'tmp'), { recursive: true })
      assert.equal(checkIgnore(dir, 'tmp/x'), true, '/tmp/ must ignore the root scratch dir')
      assert.equal(checkIgnore(dir, 'src/tmp/x'), false, 'and must NOT reach a nested same-named dir - that is the whole anchoring contract')
      assert.equal(checkIgnore(dir, 'dist/y'), true, '/dist/ ignores a root build output')
      assert.equal(checkIgnore(dir, 'src/dist/y'), false, 'not a component import path named dist')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the lock file is tracked and the guard proves it (non-vacuity: a deleted lock reads MISSING)', () => {
    const out = (() => {
      try {
        return execFileSync('git', ['-C', join(__dirname, '..'), 'ls-files', '--', 'yarn.lock'], {
          encoding: 'utf8',
          stdio: 'pipe',
        })
      } catch {
        return ''
      }
    })()
    assert.equal(out.trim(), 'yarn.lock', 'yarn.lock must be tracked on this branch - an empty answer here is exactly what a missing lock looks like')
  })
})
