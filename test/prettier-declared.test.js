const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { readFileSync, existsSync, realpathSync } = require('node:fs')
const { join } = require('node:path')

// #128: forty-eight merged PRs in this repo carry a `prettier --check` bar in their bodies while the
// repo declared no prettier at all - so every one of those rc-0 attestations was produced by whatever
// binary answered `npx prettier`, which was a GLOBAL install another agent had added mid-session. These
// arms make the judging release a property of the project: an exact pin in package.json, the resolved
// copy inside this tree, and the local bin on the path.
//
// The refusal arms matter as much as the success arms. prettier can print "All matched files use
// Prettier code style!" *while* reporting that a pattern matched nothing (pitcairn #1094 measured exit 2
// for that shape), and a copy outside the project silently loses `.prettierrc` and judges by defaults -
// which is how a phantom 166-line diff reached pitcairn #899's review. Both are proven here over stdin,
// never by writing into the tree: a test that drops a file in the repo root is a file other agents'
// `git status` will read as someone's work, and a test that spawns `node --test` on itself inherits
// NODE_TEST_CONTEXT, skips, and exits 0 having run nothing.
const repoRoot = join(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const declared = pkg.devDependencies && pkg.devDependencies.prettier
const localPkg = join(repoRoot, 'node_modules', 'prettier', 'package.json')
const localBin = join(repoRoot, 'node_modules', '.bin', 'prettier')

// `semi: false` is the axis, because printWidth here is 80 and 80 is also prettier's default - a
// width-based fixture would make the two sides agree for the wrong reason.
const SEMI_DIRTY = 'const answer = 42;\n'
const UNPARSABLE = 'const = =\n'

const prettier = (args, opts = {}) =>
  spawnSync('npx', ['--no-install', 'prettier', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    ...opts,
  })

describe('#128 prettier is declared, resolved locally, and loud when it cannot read', () => {
  it('package.json carries an exact pin, not a range', () => {
    assert.ok(
      declared,
      'package.json declares no devDependencies.prettier - the style bar has no owner',
    )
    assert.match(
      declared,
      /^\d+\.\d+\.\d+$/,
      `expected an exact version, got "${declared}" - a range lets the installer pick`,
    )
  })

  it('the installed copy is the declared release', () => {
    assert.ok(
      existsSync(localPkg),
      'prettier is not installed in this tree - run yarn install before judging style',
    )
    assert.equal(
      JSON.parse(readFileSync(localPkg, 'utf8')).version,
      declared,
      'the resolved prettier is not the declared release',
    )
  })

  it('npx answers the project copy, and the local bin lives inside the tree', () => {
    const r = prettier(['--version'])
    assert.equal(
      r.status,
      0,
      `npx prettier --version failed: ${r.stderr.slice(0, 160)}`,
    )
    assert.equal(
      r.stdout.trim(),
      declared,
      'npx answered another prettier than the project declared',
    )
    const where = spawnSync(
      'node',
      ['-e', 'console.log(require.resolve("prettier/package.json"))'],
      { cwd: repoRoot, encoding: 'utf8' },
    )
    // Guarded before the realpath: with the package moved away realpathSync throws a bare ENOENT here,
    // which is loud but names nothing - a refusal should tell the reader to run yarn install.
    assert.ok(
      existsSync(localPkg),
      'prettier is not installed in this tree - run yarn install before judging style',
    )
    assert.equal(
      where.stdout.trim(),
      realpathSync(localPkg),
      'require.resolve escaped the project tree',
    )
    assert.ok(
      existsSync(localBin),
      'no local bin - a PATH lookup would reach the global install',
    )
    assert.ok(
      realpathSync(localBin).startsWith(
        realpathSync(join(repoRoot, 'node_modules')),
      ),
      'the local bin points outside this tree',
    )
  })

  it('config resolution is load-bearing: the same bytes format differently by path', () => {
    const here = prettier(['--stdin-filepath', 'test/probe-128.js'], {
      input: SEMI_DIRTY,
    })
    const away = prettier(['--stdin-filepath', '/tmp/probe-128.js'], {
      input: SEMI_DIRTY,
    })
    assert.equal(
      here.status,
      0,
      `in-project format refused: ${here.stderr.slice(0, 140)}`,
    )
    assert.equal(
      away.status,
      0,
      `configless format refused: ${away.stderr.slice(0, 140)}`,
    )
    assert.ok(
      !here.stdout.includes('42;'),
      '.prettierrc (semi: false) did not reach the in-project read',
    )
    assert.ok(
      away.stdout.includes('42;'),
      'the two paths agreed - config is not what separates them, so this arm proves nothing',
    )
  })

  it('a pattern that matches nothing is an error, never a pass line', () => {
    const r = prettier(['--check', 'no-such-dir-128/**/*'])
    assert.notEqual(r.status, 0, 'an unmatched pattern reported success')
    assert.match(
      r.stdout + r.stderr,
      /No files matching/,
      'the run failed for a reason other than no-match',
    )
  })

  it('unparsable bytes refuse loudly instead of narrating a clean report', () => {
    const r = prettier(['--stdin-filepath', 'test/probe-128.js'], {
      input: UNPARSABLE,
    })
    assert.notEqual(r.status, 0, 'unparsable bytes were accepted')
    assert.match(
      r.stdout + r.stderr,
      /error|SyntaxError/i,
      'the refusal printed no error',
    )
    assert.doesNotMatch(
      r.stdout,
      /All matched files use Prettier code style!/,
      'a refused parse was called a pass',
    )
  })

  it('the suite glob that collects this file is quoted, and this file matches it', () => {
    const spec = pkg.scripts.test
    assert.match(
      spec,
      /'test\/\*\*\/\*\.test\.js'/,
      `the test script is unquoted or reshaped - an unquoted glob is chosen by the repo's file layout (pitcairn #993): ${spec}`,
    )
    assert.match(
      __filename.replace(realpathSync(repoRoot) + '/', ''),
      /^test\/.*\.test\.js$/,
      'this file sits outside the collected shape',
    )
  })
})
