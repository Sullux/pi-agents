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
    return text.trim() ? { text } : { error: `nothing to post\n${HUB_USAGE}` }
  }

module.exports = { HubText, HUB_USAGE }
