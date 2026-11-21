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
})
