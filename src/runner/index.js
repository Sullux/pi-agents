const { checkBacklogAvailability } = require('./preflight')
const { waitInterruptible } = require('./countdown')
const { runPiSession } = require('./session')
const { SessionTracker } = require('./sessionTracker')
const { adviceProvenanceLine } = require('../cli/runner-currency')

// #90: join the per-PR advice that `preflight` computed - do NOT re-derive causes here, or this renderer
// drifts from the classifier exactly the way #87's writer and #87's matcher did. Cap the list so a
// 20-PR board cannot bury the prompt, and say how many were dropped rather than truncating silently.
const MAX_GAP_LINES = 4

const describeReviewGaps = (gaps = []) => {
  const owed = gaps.filter((g) => g.gap !== 'reviewed')
  if (owed.length === 0) return ''
  const shown = owed
    .slice(0, MAX_GAP_LINES)
    .map((g) => `#${g.number}: ${g.hint}`)
    .join('; ')
  const rest = owed.length - Math.min(owed.length, MAX_GAP_LINES)
  const suffix = rest > 0 ? ` (+${rest} more)` : ''
  return `Review owed on ${owed.length} open PR${owed.length === 1 ? '' : 's'} - ${shown}${suffix}`
}

const resolveCyclePrompt = ({
  isNewTask = false,
  steering = '',
  reviewGaps = [],
  closures = null,
  codeCurrency = '',
  runnerCurrency = null,
} = {}) => {
  const base = isNewTask
    ? 'Proceed with development using the coordinate skill (finish any in-progress work, or check the board and PRs if ready for a new task).'
    : 'Continue development using the coordinate skill.'
  const hint = describeReviewGaps(reviewGaps)
  let withHint = hint ? `${base}\n${hint}` : base
  // #99: the closure report is preflight's, not this file's - render what the scan measured, including
  // its "0 unattested of N scanned" form, so a clean sweep and a blind one stay distinguishable to the
  // agent reading the prompt. An unreadable scan says UNKNOWN in its own note.
  if (closures?.note) withHint = `${withHint}\n${closures.note}`
  // #122: the runner outlives the merges it should have picked up, so the agent is told which code is
  // talking to it. Empty string means the tree has not moved under this process (or a read failed and
  // the note was suppressed) - silence is only ever produced by those two states, never by guessing.
  if (codeCurrency) withHint = `${withHint}\n${codeCurrency}`
  // #133: the provenance rides the ADVICE itself, not just the prompt beside it. The reading comes from
  // the injected seam (a /proc walk plus git), so a fake whose reads throw must yield no line and no
  // crash - suppressed here means the seam was called and failed, which a pin distinguishes from an
  // absent seam never being consulted at all. Current boot prints nothing: no noise for no defect.
  const hasAdvice = Boolean(hint || closures?.note)
  if (hasAdvice && runnerCurrency) {
    let read
    try {
      read = runnerCurrency.selfRead()
    } catch {
      read = undefined
    }
    const line = adviceProvenanceLine(read)
    if (line) withHint = `${withHint}\n${line}`
  }
  return steering
    ? `${withHint} Explicit steering from user: ${steering}`
    : withHint
}

const Runner = ({
  github,
  agent,
  project,
  targetPath,
  steering = '',
  model,
  thinking,
  env = {},
  sessionTracker,
  waitImpl = waitInterruptible,
  sessionImpl = runPiSession,
  codeCurrency = null,
  runnerCurrency = null,
} = {}) => {
  const runLoop = async ({ maxCycles = Infinity, onCycle } = {}) => {
    if (sessionTracker && project) {
      sessionTracker.startSession(agent, project)
    }

    let cycle = 1
    let previousReason = null

    try {
      while (cycle <= maxCycles) {
        if (onCycle) onCycle(cycle)

        // #122: re-read each cycle, not once at boot - the tree moves under a long-running daemon, and
        // a note computed at startup would be exactly as stale as the code it warns about.
        const currencyNote = codeCurrency?.describe() ?? ''

        // 1. Preflight check
        const availability = await checkBacklogAvailability({ github, agent })

        if (availability.status === 'idle_empty') {
          if (sessionTracker)
            sessionTracker.updateStatus(agent, 'waiting (empty)')
          const cancelled = await waitImpl(
            availability.waitSeconds,
            '[Backlog Empty] No open issues in repository.',
          )
          if (cancelled) return { stopped: true, reason: 'user_exit', cycle }
          continue
        }

        if (availability.status === 'idle_busy') {
          if (sessionTracker)
            sessionTracker.updateStatus(agent, 'waiting (busy)')
          const cancelled = await waitImpl(
            availability.waitSeconds,
            '[Contention] All open issues claimed; waiting on peer PRs.',
          )
          if (cancelled) return { stopped: true, reason: 'user_exit', cycle }
          continue
        }

        // 2. Work available -> Run Pi session
        const isNewTask =
          previousReason === 'owned_claims' &&
          availability.reason === 'unclaimed_tasks'
        previousReason = availability.reason

        if (sessionTracker) sessionTracker.updateStatus(agent, 'running')
        await sessionImpl({
          targetPath,
          prompt: resolveCyclePrompt({
            isNewTask,
            steering,
            reviewGaps: availability.reviewGaps || [],
            closures: availability.closures || null,
            codeCurrency: currencyNote,
            runnerCurrency,
          }),
          continueSession: !isNewTask,
          model,
          thinking,
          env,
        })

        cycle += 1

        // 10s cooldown between sessions
        if (sessionTracker) sessionTracker.updateStatus(agent, 'cooldown')
        const cancelledCooldown = await waitImpl(
          10,
          '[Session Complete] Waiting 10s cooldown before next cycle.',
        )
        if (cancelledCooldown)
          return { stopped: true, reason: 'user_exit', cycle }
      }

      return { stopped: true, reason: 'max_cycles_reached', cycle }
    } finally {
      if (sessionTracker) sessionTracker.endSession(agent)
    }
  }

  return {
    runLoop,
  }
}

module.exports = {
  Runner,
  SessionTracker,
  resolveCyclePrompt,
  describeReviewGaps,
}
