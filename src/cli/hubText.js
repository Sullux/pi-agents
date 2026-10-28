// #3: `page coord hub` took its text as a POSITIONAL only. parseArgs consumes any
// `--key value` pair into `flags`, so `coord hub --body-file /tmp/x.md` left
// positionals at exactly ['hub'] and the verb posted a 23-byte header-only comment to
// the fleet hub while printing `Posted to hub` and exiting 0. A flag plus trailing prose
// was worse: it posted the prose and silently discarded the file.
//
// Resolve every source a caller may have reached for and CONCATENATE them, so no part of
// the message can be dropped quietly. Refusing empty text here is only the first of two
// guards - coord.hub strips a leading `on|blocked|next`, so `hub on` resolves non-empty
// here and must still be caught there.
const HUB_USAGE =
  'Usage: page coord hub <text> | --body <text> | --body-file <path>'

// #29 guard 1: an unreplaced placeholder reaches the fleet hub as a *plausible*
// timestamp. Measured on pitcairn hub #4: a line composed as `hub "17:0X echo: ..."`
// posted the literal `17:0X` while printing `Posted to hub #4` and exiting 0, and a
// second agent published `17:1xZ` the same evening - an author-visible TODO that the
// hub, which the fleet reads as a timeline, cannot distinguish from a real clock. The
// tool refuses the shapes that can only ever be unread (a digit slot holding x/X, a
// bare XX, a `<...>` template slot, a line that begins TODO/FIXME) and never inspects
// a well-formed time: prose quoting `15:26:03Z` is accurate incident reporting, and a
// guard that reds accurate lines gets deleted inside a week - the same reason
// parseScope anchors on line-initial `## Files` instead of matching anywhere.
// Quoting one of these tokens is legitimate, so a backtick code span is exempt.
const CODE_SPAN_RE = /`[^`\n]*`/g
const PLACEHOLDER_FORMS = [
  ['an unreplaced time token', /\b\d{1,2}:[0-9xX][xX](?::[0-9xX]{2})?Z?\b/],
  ['a bare XX', /\bXX\b/],
  ['a <sha> template slot', /<(?:sha|commit|ref|oid)[^>]*>/i],
  ['a <path> template slot', /<(?:path|file|dir)[^>]*>/i],
  ['a <number> template slot', /<(?:n|num|number|issue|pr)[^>]*>/i],
]
// The group CAPTURES: `lead[1]` is what names the token in the refusal. Written as a
// non-capturing `(?:TODO|FIXME)` it returned undefined and threw TypeError instead of
// refusing - found by test/cli/hubText.test.js's slot-shape arm, not by reading.
const LEADING_PROSE_RE = /^\W{0,3}(TODO|FIXME)\b/i

const findPlaceholder = (text) => {
  const firstLine = String(text).split('\n')[0].replace(CODE_SPAN_RE, '')
  const hit = PLACEHOLDER_FORMS.find(([, re]) => re.test(firstLine))
  if (hit) return hit[0]
  const lead = LEADING_PROSE_RE.exec(firstLine)
  return lead ? `a leading ${lead[1].toUpperCase()}` : ''
}

// #29 guard 2: the hub line cannot exit without a valid stamp, so an author never
// needs to type one. Validation is confined to the LEADING token this function owns -
// scanning the body for `HH:MMZ` matched the tail of a full `HH:MM:SSZ` and accused a
// teammate of posting hour-59 times (seven "invalid stamps", all of them `26:03Z`-style
// fragments of legitimate timestamps in his prose). The optional `**SYNC**` head is
// consumed because hub() composes the marker before stamping, and the stamp belongs on
// the message line, not above the protocol marker.
const SYNC_HEAD_RE = /^(?:\*\*SYNC\*\*[^\n]*\n\n)?/
const LEADING_STAMP_RE = /^(\d{2}):(\d{2})(?::(\d{2}))?Z(?=$|\s)/

const stampOfUtc = (now) => new Date(now()).toISOString().slice(11, 16) + 'Z'

const ensureStamp = (text, now) => {
  const head = SYNC_HEAD_RE.exec(text)[0]
  const rest = text.slice(head.length)
  const stamp = LEADING_STAMP_RE.exec(rest)
  if (stamp) {
    const [, hh, mm, ss] = stamp
    const badTime =
      Number(hh) > 23 ||
      Number(mm) > 59 ||
      (ss !== undefined && Number(ss) > 59)
    if (badTime)
      return {
        error:
          `hub stamp "${stamp[0]}" is not a valid UTC time (hour 00-23, ` +
          'minute 00-59); nothing was posted',
      }
    return { text }
  }
  return { text: `${head}${stampOfUtc(now)} ${rest}` }
}

const HubText =
  (readFile) =>
  (flags = {}, positional = '') => {
    const fileFlag = flags['body-file']
    if (fileFlag === true)
      return { error: `--body-file needs a path\n${HUB_USAGE}` }
    if (flags.body === true) return { error: `--body needs text\n${HUB_USAGE}` }

    const parts = [
      typeof fileFlag === 'string' ? readFile(fileFlag) : '',
      typeof flags.body === 'string' ? flags.body : '',
      positional,
    ]
    const text = parts.filter((part) => part.trim().length > 0).join('\n\n')
    if (!text.trim()) return { error: `nothing to post\n${HUB_USAGE}` }
    // The placeholder check runs over the JOINED text, so a body file carrying an
    // unread token refuses too - not just the hand-typed positional that motivated
    // #29. Refusal is on the returned error, so no caller can post past it.
    const placeholder = findPlaceholder(text)
    if (placeholder)
      return {
        error:
          `hub text carries ${placeholder} on its first line - a token no clock was ` +
          'ever read from. Read one with: date -u +%H:%MZ, or wrap a QUOTED token in ' +
          `backticks to post it as prose.\n${HUB_USAGE}`,
      }
    return { text }
  }

module.exports = {
  HubText,
  HUB_USAGE,
  findPlaceholder,
  ensureStamp,
  stampOfUtc,
  LEADING_STAMP_RE,
}
