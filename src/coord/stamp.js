// #167: ONE stamp formatter for every coord marker, and ONE parser for the arbitration field.
//
// The defect this closes: five marker templates (CLAIM/STATUS/REVIEW/DONE/SYNC) each
// hand-interpolated `now()` into `at:`, and the consumer in owner.js read the field with
// /\|\s*at:\s*(\d+)/ - a DIGIT-PREFIX match. A hand-authored `at: 20:16Z` therefore parsed as
// epoch 20 (twenty milliseconds from 1970) and silently won or lost every Rule C comparison;
// an ISO `at: 2026-10-26T15:58:04Z` parsed as 2026. Measured, not theorized:
//   '| at: 20:16Z'.match(/\|\s*at:\s*(\d+)/) -> ['| at: 20', '20']
//
// The emission format stays epoch milliseconds - the house convention for data (Charles's
// standing instruction), and #167's out-of-scope clause explicitly permits "epoch ms
// everywhere". hubText's `stampOfUtc` (HH:MMZ) is the HUMAN message-line stamp, a different
// field by design; it is date-less and must never become the arbitration token. Unifying the
// marker field through one named formatter is what stops a sixth verb from forgetting it.

// The renderer. Takes the injected clock, returns the epoch-ms string the marker carries.
const stampOfMarker = (now) => `${now()}`

// The field extractor: the WHOLE token up to whitespace/pipe/newline, never a digit prefix.
const MARKER_STAMP_RE = /\|\s*at:\s*([^\s|]+)/

// Full ISO 8601 with a DATE - the shape the historical (Sep/Oct) markers carry. Date-less
// forms (HH:MMZ) cannot express an ordering across midnight and are refused, not coerced.
const ISO_STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/

// parseStamp: a discriminated result, never a bare number that could be NaN.
//   epoch-ms (all digits)        -> { ok: true, ms }
//   full ISO 8601 (valid date)   -> { ok: true, ms }
//   anything else, incl. HH:MMZ  -> { ok: false, token }  (the raw token, for the loud refusal)
const parseStamp = (token) => {
  if (/^\d+$/.test(token)) return { ok: true, ms: Number(token) }
  if (ISO_STAMP_RE.test(token)) {
    const ms = Date.parse(token)
    if (!Number.isNaN(ms)) return { ok: true, ms }
  }
  return { ok: false, token }
}

module.exports = { stampOfMarker, MARKER_STAMP_RE, parseStamp }
