const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const {
  SessionActivityProbe,
  sessionDirFor,
  lineHasToolActivity,
} = require('../../src/runner/sessionActivity')

describe('SessionActivityProbe', () => {
  it('derives Pi session directory using cwd dash encoding', () => {
    const dir = sessionDirFor('/home/charles/agents/Echo/pp', {
      os: { homedir: () => '/home/charles' },
      path,
    })
    assert.equal(
      dir,
      '/home/charles/.pi/agent/sessions/--home-charles-agents-Echo-pp--',
    )
  })

  it('lineHasToolActivity distinguishes toolUse/toolCall/toolResult from Idle text', () => {
    assert.equal(
      lineHasToolActivity(
        JSON.stringify({
          type: 'message',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Idle' }],
            stopReason: 'stop',
          },
        }),
      ),
      false,
    )
    assert.equal(
      lineHasToolActivity(
        JSON.stringify({
          type: 'message',
          message: {
            role: 'assistant',
            content: [{ type: 'toolCall', name: 'bash', arguments: {} }],
            stopReason: 'toolUse',
          },
        }),
      ),
      true,
    )
    assert.equal(
      lineHasToolActivity(
        JSON.stringify({
          type: 'message',
          message: {
            role: 'toolResult',
            content: [{ type: 'text', text: 'ok' }],
          },
        }),
      ),
      true,
    )
  })

  it('detects zero tool activity vs tool activity across appended jsonl delta', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-probe-'))
    try {
      const targetPath = '/work/echo/pp'
      const sessDir = sessionDirFor(targetPath, {
        os: { homedir: () => tmpHome },
        path,
      })
      fs.mkdirSync(sessDir, { recursive: true })
      const sessFile = path.join(sessDir, 'session.jsonl')
      fs.writeFileSync(
        sessFile,
        `${JSON.stringify({
          type: 'message',
          message: {
            role: 'assistant',
            stopReason: 'toolUse',
            content: [{ type: 'toolCall', name: 'bash' }],
          },
        })}\n`,
      )

      const probe = SessionActivityProbe({
        os: { homedir: () => tmpHome },
        path,
      })

      // Turn 1: appends only an Idle assistant response (prior toolUse before snapshot is ignored!)
      const before1 = probe.snapshot(targetPath)
      fs.appendFileSync(
        sessFile,
        `${JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Continue' }] } })}\n` +
          `${JSON.stringify({ type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Idle' }] } })}\n`,
      )
      assert.deepEqual(probe.inspectDelta(targetPath, before1), {
        hadToolUse: false,
      })

      // Turn 2: appends a tool call
      const before2 = probe.snapshot(targetPath)
      fs.appendFileSync(
        sessFile,
        `${JSON.stringify({ type: 'message', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', name: 'read' }] } })}\n`,
      )
      assert.deepEqual(probe.inspectDelta(targetPath, before2), {
        hadToolUse: true,
      })
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('returns hadToolUse: undefined when no assistant output was appended', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-probe-empty-'))
    try {
      const probe = SessionActivityProbe({
        os: { homedir: () => tmpHome },
        path,
      })
      const before = probe.snapshot('/nonexistent/path')
      assert.deepEqual(probe.inspectDelta('/nonexistent/path', before), {
        hadToolUse: undefined,
      })
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('inspectTurn detects read-only idle-exit spins without misclassifying productive work', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-turn-'))
    try {
      const targetPath = '/work/delta/pp'
      const sessDir = sessionDirFor(targetPath, {
        os: { homedir: () => tmpHome },
        path,
      })
      fs.mkdirSync(sessDir, { recursive: true })
      const sessFile = path.join(sessDir, 'session.jsonl')
      fs.writeFileSync(sessFile, '')

      const probe = SessionActivityProbe({
        os: { homedir: () => tmpHome },
        path,
      })

      // Turn 1: read-only bash check followed by explicit idle-exit summary
      const b1 = probe.snapshot(targetPath)
      fs.appendFileSync(
        sessFile,
        [
          {
            type: 'message',
            message: {
              role: 'assistant',
              stopReason: 'toolUse',
              content: [{ type: 'toolCall', name: 'bash', arguments: {} }],
            },
          },
          {
            type: 'message',
            message: {
              role: 'toolResult',
              content: [{ type: 'text', text: '1401 open' }],
            },
          },
          {
            type: 'message',
            message: {
              role: 'assistant',
              stopReason: 'stop',
              content: [
                {
                  type: 'text',
                  text: 'Unchanged — #1401 open, no review yet. No claimable tasks, no pending reviews. Exiting cleanly per the idle-exit rule.',
                },
              ],
            },
          },
        ]
          .map((e) => JSON.stringify(e))
          .join('\n') + '\n',
      )
      const t1 = probe.inspectTurn(targetPath, b1)
      assert.equal(t1.hadToolUse, true)
      assert.equal(t1.hadEdit, false)
      assert.equal(t1.isIdleExit, true)

      // Turn 2: real edit + exit prose is NOT classified as idle spin
      const b2 = probe.snapshot(targetPath)
      fs.appendFileSync(
        sessFile,
        [
          {
            type: 'message',
            message: {
              role: 'assistant',
              stopReason: 'toolUse',
              content: [{ type: 'toolCall', name: 'edit', arguments: {} }],
            },
          },
          {
            type: 'message',
            message: {
              role: 'assistant',
              stopReason: 'stop',
              content: [
                {
                  type: 'text',
                  text: 'Fixed bug and pushed PR. Exiting cleanly.',
                },
              ],
            },
          },
        ]
          .map((e) => JSON.stringify(e))
          .join('\n') + '\n',
      )
      const t2 = probe.inspectTurn(targetPath, b2)
      assert.equal(t2.hadToolUse, true)
      assert.equal(t2.hadEdit, true)
      assert.equal(t2.isIdleExit, false)

      // Turn 3: non-edit bash action (e.g., merged PR) is NOT classified as idle spin
      const b3 = probe.snapshot(targetPath)
      fs.appendFileSync(
        sessFile,
        [
          {
            type: 'message',
            message: {
              role: 'assistant',
              stopReason: 'toolUse',
              content: [{ type: 'toolCall', name: 'bash', arguments: {} }],
            },
          },
          {
            type: 'message',
            message: {
              role: 'assistant',
              stopReason: 'stop',
              content: [
                {
                  type: 'text',
                  text: 'Merged #1401 and closed #1352. Exiting cleanly.',
                },
              ],
            },
          },
        ]
          .map((e) => JSON.stringify(e))
          .join('\n') + '\n',
      )
      const t3 = probe.inspectTurn(targetPath, b3)
      assert.equal(t3.hadToolUse, true)
      assert.equal(t3.hadEdit, false)
      assert.equal(t3.isIdleExit, false)
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    }
  })
})
