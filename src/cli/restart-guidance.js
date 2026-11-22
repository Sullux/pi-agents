// #166 boxes 4/5: machine-readable restart guidance at the point of decision, READ-ONLY (#130's standing
// rule - this names the pid and the exact two-step, it never signals). For each live runner whose boot is
// behind the tip at the moment of the read, it names the pid, the agent/project, the liveness (idle or
// in-wave, so the operator knows whether killing discards a wave), and - when the advisory has fired
// unchanged N times - the `same advisory xN` count that makes "advises only" actionable. behindOf is
// injected so the count is computed from the boot commit AND the current tip, never a publish-time stale.
const { classifyLiveness } = require('../runner/liveness')
const { runnerIndex } = require('./runner-currency')

const restartGuidance = ({ runners = [], sessions = [], behindOf }) => {
  const lines = []
  for (const r of runners) {
    const behind = behindOf(r.pid)
    if (behind <= 0) continue
    const sess = sessions.find((s) => s.pid === r.pid)
    const idx = runnerIndex(r.argv || [])
    const agent = sess?.agent || r.argv?.[idx + 2] || '?'
    const project = sess?.project || r.argv?.[idx + 3] || '?'
    const liveness = classifyLiveness({
      waveState: sess?.waveState,
      behind,
      advisoryStreak: sess?.advisoryStreak,
    })
    const streak = sess?.advisoryStreak || 0
    const count = streak >= 2 ? `, same advisory x${streak}` : ''
    lines.push(
      `  pid ${r.pid} (${agent} ${project}) ${behind} behind, ${liveness}${count} - restart: kill ${r.pid} then page start ${agent} ${project}`,
    )
  }
  return lines
}

module.exports = { restartGuidance }
