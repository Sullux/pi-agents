const { labelKey } = require('./scope')

// #79: does this repo actually carry the coord label taxonomy?
//
// Sullux/pi-agents has only GitHub's nine defaults - no `status:*`, no `ws:*`, no `hub` - so every
// coord verb's label write is a doomed `gh issue edit`, and the CLI then prints
// `! labels unchanged: <gh's own reason> - the protocol comment landed`. That output is honest and
// it is #34's deliberate design (best-effort AND loud, because a silent `Claimed` is a lie of the
// other shape: an agent believes labels moved and reads a board that never changed). This file does
// not soften that. It answers one question so the doomed call can be skipped and the line can say
// what is actually true about this repo, instead of quoting an API error for a state that is
// permanent and already known.
//
// Deliberately FAIL-OPEN. A transient `listLabels` failure returns `unknown`, the verb writes its
// labels exactly as it does today, and nothing is cached - because caching a failure as "label-less"
// would silently stop moving labels in a repo that really has them, which is the worse bug by a wide
// margin. A double with no `listLabels` seam is also `unknown`, which is what keeps every existing
// test double in this repo behaving precisely as it does now.

const STATUS_PREFIX = 'status:'

const CoordTaxonomy = ({ github }) => {
  let cached

  const probe = async () => {
    if (cached) return cached
    if (typeof github.listLabels !== 'function') return { known: false }
    let names
    try {
      names = await github.listLabels()
    } catch {
      return { known: false }
    }
    const hasStatus = (names || []).some((n) =>
      labelKey(typeof n === 'string' ? n : n?.name).startsWith(STATUS_PREFIX),
    )
    cached = { known: true, hasStatus }
    return cached
  }

  // true only when the taxonomy was READ successfully and carries no `status:` family at all
  const labelWriteIsMeaningless = async () => {
    const { known, hasStatus } = await probe()
    return known === true && hasStatus === false
  }

  return { probe, labelWriteIsMeaningless }
}

const LABELLESS_NOTICE =
  'this repo carries no status: labels, so no label write was attempted - the CLAIM/REVIEW/DONE timeline is the record (#79)'

module.exports = { CoordTaxonomy, LABELLESS_NOTICE }
