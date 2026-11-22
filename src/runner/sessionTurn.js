const EDIT_TOOLS = ['edit', 'write']

const IDLE_EXIT_PHRASE_RE =
  /\b(?:unchanged|no claimable|nothing to claim|nothing claimable|no pending reviews|nothing to review|no actionable|standing by|no work available)\b/i

const IDLE_EXIT_ACTION_RE = /\b(?:exiting|exit|idle|re-engage|wait)\b/i

const parseEntries = (lines) => {
  const entries = []
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line))
    } catch {
      // Ignore partial or malformed lines
    }
  }
  return entries
}

const isIdleMessage = (text) => {
  const trimmed = String(text || '').trim()
  if (!trimmed) return false
  if (trimmed.toLowerCase() === 'idle') return true
  return IDLE_EXIT_PHRASE_RE.test(trimmed) && IDLE_EXIT_ACTION_RE.test(trimmed)
}

const extractAssistantText = (entry) => {
  const msg = entry?.message
  if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) return ''
  return msg.content
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
    .trim()
}

const hasEditActivity = (entries) =>
  entries.some((entry) => {
    const msg = entry?.message
    if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) return false
    return msg.content.some(
      (c) =>
        c?.type === 'toolCall' &&
        EDIT_TOOLS.includes(String(c.name || '').toLowerCase()),
    )
  })

const summarizeTurnLines = (lines, lineHasToolActivity) => {
  const entries = parseEntries(lines)
  const assistantEntries = entries.filter(
    (e) => e?.message?.role === 'assistant',
  )
  if (!assistantEntries.length) return { hadToolUse: undefined }

  const hadToolUse = lines.some(lineHasToolActivity)
  const hadEdit = hasEditActivity(entries)
  const assistantText = extractAssistantText(
    assistantEntries[assistantEntries.length - 1],
  )
  const isIdleExit = !hadEdit && isIdleMessage(assistantText)

  return { hadToolUse, hadEdit, assistantText, isIdleExit }
}

module.exports = {
  isIdleMessage,
  summarizeTurnLines,
}
