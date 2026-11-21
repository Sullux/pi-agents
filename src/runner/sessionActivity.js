const defaultFs = require('node:fs')
const defaultOs = require('node:os')
const defaultPath = require('node:path')

const sessionDirFor = (
  targetPath,
  { os = defaultOs, path = defaultPath } = {},
) => {
  const resolved = path.resolve(targetPath)
  const slug = resolved.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')
  return path.join(os.homedir(), '.pi', 'agent', 'sessions', `--${slug}--`)
}

const listSessionFiles = (dir, fs) => {
  try {
    if (!fs.existsSync(dir)) return {}
    const entries = fs.readdirSync(dir)
    const sizes = {}
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue
      const full = `${dir}/${name}`
      try {
        sizes[full] = fs.statSync(full).size
      } catch {
        // Ignore transient/unreadable entries
      }
    }
    return sizes
  } catch {
    return {}
  }
}

const readAppendedSlice = (filePath, startOffset, endOffset, fs) => {
  const length = endOffset - startOffset
  if (length <= 0) return ''
  const fd = fs.openSync(filePath, 'r')
  try {
    const buf = Buffer.allocUnsafe(length)
    let read = 0
    while (read < length) {
      const n = fs.readSync(fd, buf, read, length - read, startOffset + read)
      if (n <= 0) break
      read += n
    }
    return buf.subarray(0, read).toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

const lineHasToolActivity = (line) => {
  if (!line.trim()) return false
  try {
    const entry = JSON.parse(line)
    const msg = entry?.message
    if (!msg) return false
    if (msg.role === 'toolResult') return true
    if (msg.role === 'assistant') {
      if (msg.stopReason === 'toolUse') return true
      if (
        Array.isArray(msg.content) &&
        msg.content.some((c) => c?.type === 'toolCall')
      ) {
        return true
      }
    }
    return false
  } catch {
    return false
  }
}

const hasAssistantOutput = (lines) =>
  lines.some((line) => {
    if (!line.trim()) return false
    try {
      const entry = JSON.parse(line)
      return entry?.message?.role === 'assistant'
    } catch {
      return false
    }
  })

const SessionActivityProbe = ({
  fs = defaultFs,
  os = defaultOs,
  path = defaultPath,
} = {}) => {
  const snapshot = (targetPath) => {
    if (!targetPath) return {}
    const dir = sessionDirFor(targetPath, { os, path })
    return listSessionFiles(dir, fs)
  }

  const inspectDelta = (targetPath, before = {}) => {
    if (!targetPath) return { hadToolUse: undefined }
    const dir = sessionDirFor(targetPath, { os, path })
    const after = listSessionFiles(dir, fs)
    const lines = []
    for (const [filePath, size] of Object.entries(after)) {
      const prev = before[filePath] || 0
      if (size <= prev) continue
      try {
        const chunk = readAppendedSlice(filePath, prev, size, fs)
        lines.push(...chunk.split('\n'))
      } catch {
        return { hadToolUse: undefined }
      }
    }
    if (!hasAssistantOutput(lines)) return { hadToolUse: undefined }
    return { hadToolUse: lines.some(lineHasToolActivity) }
  }

  return { snapshot, inspectDelta }
}

module.exports = {
  SessionActivityProbe,
  sessionDirFor,
  lineHasToolActivity,
}
