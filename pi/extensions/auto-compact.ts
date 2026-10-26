import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

const resolveThresholdPercent = (
  modelId: string = '',
  defaultPercent: number = 16,
): number => {
  if (process.env.COMPACT_MODEL_OVERRIDES) {
    try {
      const overrides = JSON.parse(process.env.COMPACT_MODEL_OVERRIDES)
      for (const [key, val] of Object.entries(overrides)) {
        if (modelId.toLowerCase().includes(key.toLowerCase())) {
          return Number(val)
        }
      }
    } catch {}
  }

  const sanitized = modelId.toUpperCase().replace(/[^A-Z0-9]/g, '_')
  const exact = process.env[`COMPACT_PERCENT_${sanitized}`]
  if (exact) return Number(exact)

  for (const [envKey, envVal] of Object.entries(process.env)) {
    if (
      envKey.startsWith('COMPACT_PERCENT_') &&
      envKey !== 'COMPACT_PERCENT_TOKENS'
    ) {
      const suffix = envKey
        .replace('COMPACT_PERCENT_', '')
        .toLowerCase()
        .replace(/_/g, '')
      const cleanModel = modelId.toLowerCase().replace(/[^a-z0-9]/g, '')
      if (cleanModel.includes(suffix)) {
        return Number(envVal)
      }
    }
  }

  return Number(
    process.env.PI_COMPACT_PERCENT ||
      process.env.COMPACT_PERCENT ||
      defaultPercent,
  )
}

export default function (pi: ExtensionAPI) {
  // 1. Hook into Pi's compaction engine to inject domain-specific instructions
  pi.on('session_before_compact', async (event, ctx) => {
    const msg = '[auto-compact] Compacting context and preserving state...'
    if (ctx.hasUI) {
      ctx.ui.notify(msg, 'info')
    } else {
      console.log(msg)
    }

    event.customInstructions = [
      'Focus on preserving:',
      '1. Active GitHub coordinate claim status, claimed issue numbers, workstream labels, and branch names.',
      '2. Key domain decisions, entity schema updates, and completed/pending implementation tasks.',
      '3. Any active PR numbers, unresolved reviewer comments, or blockers.',
    ].join('\n')
  })

  // 2. Intercept settlement: check context usage, force and await compaction before exiting
  pi.on('agent_settled', async (_event, ctx) => {
    const usage = ctx.getContextUsage()
    const percent = usage?.percent ?? 0
    const tokens = usage?.tokens ?? 0
    const modelId = ctx.model?.id || ''

    const thresholdPercent = resolveThresholdPercent(modelId, 16)
    const thresholdTokens =
      process.env.PI_COMPACT_TOKENS || process.env.COMPACT_TOKENS
        ? Number(process.env.PI_COMPACT_TOKENS || process.env.COMPACT_TOKENS)
        : Infinity

    // Threshold: defaults to <= 16% on 1M models, or model-specific override
    if (
      percent > thresholdPercent ||
      (thresholdTokens !== Infinity && tokens > thresholdTokens)
    ) {
      const tokenMsg =
        thresholdTokens !== Infinity ? ` / ${thresholdTokens} tokens` : ''
      const msg = `[auto-compact] Context at ${percent.toFixed(1)}% (${tokens} tokens, model: ${modelId || 'default'}) exceeds ${thresholdPercent}%${tokenMsg} threshold. Forcing compaction...`
      if (ctx.hasUI) {
        ctx.ui.notify(msg, 'warning')
      } else {
        console.log(msg)
      }

      await new Promise<void>((resolve) => {
        ctx.compact({
          onComplete: () => {
            const after = ctx.getContextUsage()
            const postMsg = `[auto-compact] Compaction completed successfully. Context reduced to ${after?.percent?.toFixed(1) ?? '?'}%.`
            if (ctx.hasUI) {
              ctx.ui.notify(postMsg, 'info')
            } else {
              console.log(postMsg)
            }
            resolve()
          },
          onError: (err) => {
            const errMsg = `[auto-compact] Compaction failed: ${err.message}`
            if (ctx.hasUI) {
              ctx.ui.notify(errMsg, 'error')
            } else {
              console.error(errMsg)
            }
            resolve() // resolve anyway to avoid hanging indefinitely
          },
        })
      })
    }

    // If running under autonomous orchestration, cleanly shutdown after compaction is verified
    if (process.env.PI_AUTO_EXIT === '1') {
      if (ctx.hasUI) {
        ctx.ui.notify(
          '[orchestrator] Turn settled and context verified. Closing TUI for next cycle...',
          'info',
        )
      }
      ctx.shutdown()
    }
  })

  // 3. User diagnostic command to inspect context percentage on demand
  pi.registerCommand('check-context', {
    description: 'Check current context usage percentage and tokens',
    handler: async (_args, ctx) => {
      const usage = ctx.getContextUsage()
      const percent = usage?.percent ?? 0
      ctx.ui.notify(
        `Current context: ${percent.toFixed(1)}% (${usage?.tokens ?? 0} tokens)`,
        'info',
      )
    },
  })
}
