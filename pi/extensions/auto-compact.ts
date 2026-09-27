import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

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

    // Threshold: strictly keep context <= 16% (~160,000 tokens on 1M models)
    if (percent > 16 || tokens > 160000) {
      const msg = `[auto-compact] Context at ${percent.toFixed(1)}% (${tokens} tokens) exceeds 16% threshold. Forcing compaction...`
      if (ctx.hasUI) {
        ctx.ui.notify(msg, 'warning')
      } else {
        console.log(msg)
      }

      await new Promise<void>((resolve) => {
        ctx.compact({
          onComplete: () => {
            const after = ctx.getContextUsage()
            const postMsg = `[auto-compact] Compaction completed successfully. Context reduced to ${after?.percent?.toFixed(1) ?? '?' }%.`
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
        ctx.ui.notify('[orchestrator] Turn settled and context verified. Closing TUI for next cycle...', 'info')
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
      ctx.ui.notify(`Current context: ${percent.toFixed(1)}% (${usage?.tokens ?? 0} tokens)`, 'info')
    },
  })
}
