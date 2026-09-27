#!/usr/bin/env bash
# coord.sh - multi-agent coordination over GitHub Issues via the gh CLI.
# Protocol: ../SKILL.md and ../references/protocol.md
# Usage:    bash .agents/skills/coordinate/scripts/coord.sh <command> [args]
# Env:      COORD_AGENT (who you are), COORD_REPO, COORD_HUB, COORD_STALE_MIN
set -euo pipefail

REPO="${COORD_REPO:-Sullux/pitcairn-portal}"
AGENT="${COORD_AGENT:-unknown-agent}"
STALE_MIN="${COORD_STALE_MIN:-45}"
HUB_TITLE="Coordination hub"
# Verbs that count as a heartbeat (reset the stale timer). jq-escaped regex.
HEARTBEAT='^\\*\\*(CLAIM|STATUS|UNBLOCKED|HANDOFF)\\*\\*'
STATUSES="unclaimed claimed in-progress blocked in-review"

die()  { echo "coord: $*" >&2; exit 1; }
note() { echo "coord: $*" >&2; }
now()  { date -u +%Y-%m-%dT%H:%M:%SZ; }

usage() {
  sed -n '2,5p' "$0" | sed 's/^# //'
  cat <<'EOF'

Commands:
  setup                                  labels + pinned hub issue (idempotent)
  sync                                   board, your claims, stale, needs-human, hub tail
  board                                  open issues by ws/status/owner/files
  hub "text"                             post SYNC on the hub issue
  new "title" --ws X [--p 0|1|2] [--type task|contract|decision|bug]
      [--files G] [--done "a;b"] [--depends "#n"] [--body T] [--claim]
  claim N [--plan T] [--eta T]           assign yourself (refuses if owned)
  release N [--reason T] [--stale]       unassign (--stale: anyone, if abandoned)
  status N "text"                        heartbeat + progress
  block N --by "#m|@u" "text"            mark blocked
  unblock N "text"                       mark unblocked
  question N [--to @u] [--human] "text"  ask (--human labels needs-human)
  answer N "text"                        answer (clears needs-human)
  propose N [--to @u] "text"             propose an interface / split / plan
  accept N ["text"]                      accept latest proposal (contracts: record it)
  counter N "text"                       counter-propose (4th round escalates)
  reject N "reason"                      reject latest proposal
  handoff N --to @u "text"               transfer ownership
  review N --pr URL                      mark in-review
  done N [--pr URL] ["text"]             close + notify dependents
  stale                                  list stale claims
  show N                                 issue + protocol comment history
EOF
}

command -v gh >/dev/null 2>&1 || die "gh CLI not found: https://cli.github.com"
gh auth status >/dev/null 2>&1 || die "gh is not authenticated; run: gh auth login"
ME="$(gh api user --jq .login)"

# ---------- helpers ----------
header() { printf '**%s** | agent: %s | human: @%s | at: %s' "$1" "$AGENT" "$ME" "$(now)"; }

comment() { # issue verb body
  gh issue comment "$1" --repo "$REPO" --body "$(header "$2")"$'\n\n'"$3" >/dev/null
  echo "#$1 <- $2"
}

labels_of()    { gh issue view "$1" --repo "$REPO" --json labels --jq '.labels[].name'; }
assignees_of() { gh issue view "$1" --repo "$REPO" --json assignees --jq '.assignees[].login'; }
has_label()    { labels_of "$1" | grep -qx "$2"; }
is_mine()      { assignees_of "$1" | grep -qx "$ME"; }

# Declared file scope from the issue body's '## Files' section; empty if none.
files_of() { # issue
  gh issue view "$1" --repo "$REPO" --json body --jq '.body // ""' |
    tr '\r' '\n' |
    awk '/^## Files/{f=1;next} /^## /{f=0} f' |
    sed 's/_(none listed)_//g; s/-(none listed)-//g' |
    sed 's/^[[:space:]]*[-*][[:space:]]*//' |
    grep -vE '^(\^)?split:' |
    tr ';, ' '\n\n\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' |
    grep -v '^$' || true
}

# Issue numbers referenced as #N anywhere in a body (unique, first-ref order).
referenced_issues() { # body
  printf '%s' "$1" | grep -o '#[0-9]\+' | tr -d '#' | awk '!seen[$0]++' || true
}

# True when a path is covered by a Files entry: globs like src/x/** match
# existing AND future files, bare paths match exactly.
path_in_scope() { # path scope-list
  local p="$1" g
  while read -r g; do
    [ -z "$g" ] && continue
    [[ "$p" == $g ]] && return 0
  done <<< "$2"
  return 1
}

# True when two Files entries collide (either covers the other).
scopes_clash() { # scope-list scope-list
  local p t
  while read -r p; do
    [ -z "$p" ] && continue
    while read -r t; do
      [ -z "$t" ] && continue
      [[ "$p" == $t || "$t" == $p ]] && return 0
    done <<< "$2"
  done <<< "$1"
  return 1
}

set_status() { # issue status
  local args=(--add-label "status:$2") s
  for s in $STATUSES; do
    [ "$s" = "$2" ] || args+=(--remove-label "status:$s")
  done
  gh issue edit "$1" --repo "$REPO" "${args[@]}" >/dev/null
}

hub_number() {
  # COORD_HUB pins the hub; otherwise the lowest-numbered open hub issue wins
  # (a later dashboard issue may also carry the label).
  if [ -n "${COORD_HUB:-}" ]; then echo "$COORD_HUB"; return; fi
  gh issue list --repo "$REPO" --label hub --state open --limit 20     --json number --jq '[.[].number] | min // empty'
}

# Age in minutes since the last heartbeat verb on an issue; 999999 if none.
heartbeat_age() {
  gh issue view "$1" --repo "$REPO" --json comments --jq \
    "(([.comments[] | select(.body|test(\"$HEARTBEAT\")) | .createdAt | fromdateiso8601] | max) // 0) as \$t
     | if \$t == 0 then 999999 else ((now - \$t) / 60 | floor) end"
}

is_stale() { [ "$(heartbeat_age "$1")" -gt "$STALE_MIN" ]; }

# Generic option parser: POS[] positionals, OPT_<name> values, FLAG_<name>=1.
parse() {
  POS=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --plan|--eta|--reason|--by|--to|--pr|--ws|--p|--type|--files|--done|--depends|--body)
        [ $# -ge 2 ] || die "$1 needs a value"
        eval "OPT_${1#--}=\$2"; shift 2 ;;
      --claim|--stale|--human) eval "FLAG_${1#--}=1"; shift ;;
      --*) die "unknown option $1" ;;
      *) POS+=("$1"); shift ;;
    esac
  done
  # Arity guard (#387): bare positionals were silently absorbed and dropped,
  # posting verbs with default text ('reason: none given'). Unknown --flags die;
  # so must extras beyond the verb's arity, naming the likely flag.
  [ "${#POS[@]}" -le "${MAX_POS:-2}" ] || {
    # hub's usage line reads like a subcommand and silently ate real updates
    # for a whole session (#387) - name that trap specifically
    [ "$cmd" = hub ] &&
      die "hub takes ONE quoted argument: coord.sh hub \"your update text\" - the 'on / blocked / next' in the usage line is DESCRIPTIVE PROSE, not a subcommand (hub on \"text\" posts the literal word 'on' - a full session of lost hub updates measured, #387)"
    die "unexpected argument(s) after '$cmd': ${POS[*]:$MAX_POS} - verb text follows a NAMED flag (--reason/--plan/--eta/--pr); see usage"
  }
}

need_issue() { # sets N from POS[0]
  N="${POS[0]:-}"
  [[ "$N" =~ ^[0-9]+$ ]] || die "first argument must be an issue number"
}

mention_humans() { # issue -> "@a @b" of everyone who posted PROPOSE/COUNTER + assignees + author
  gh issue view "$1" --repo "$REPO" --json author,assignees,comments --jq '
    ([.author.login] + [.assignees[].login]
     + [.comments[] | select(.body|startswith("**PROPOSE**") or startswith("**COUNTER**")) | .author.login])
    | unique | map("@"+.) | join(" ")'
}

# ---------- commands ----------
cmd_setup() {
  note "labels on $REPO"
  while IFS='|' read -r name color desc; do
    [ -n "$name" ] || continue
    gh label create "$name" --repo "$REPO" --color "$color" --description "$desc" --force >/dev/null
    echo "  label  $name"
  done <<'EOF'
ws:os-shell|1d76db|SDE 1 - window manager, taskbar, desktop
ws:agent-chat|5319e7|SDE 2 - /api/chat, streaming UI, tool execution
ws:runtime-engine|e99695|SDE 3 - vue3-sfc-loader runner, error boundary
ws:persistence|0e8a16|SDE 4 - VFS, registry hydration, settings
ws:integration|fbca04|SDE 5 - Settings app, demo apps, polish
ws:docs|c5def5|ADRs, README, submission writing
status:unclaimed|ededed|Nobody owns this yet - claim it
status:claimed|c2e0c6|Assigned; work not started
status:in-progress|0e8a16|Actively being worked
status:blocked|b60205|Waiting on another issue or person
status:in-review|fbca04|PR open, needs review
p0|b60205|On the demo golden path - must ship
p1|d93f0b|Important, not demo-critical
p2|fef2c0|Nice to have
type:task|0075ca|A unit of work
type:contract|5319e7|Interface agreement between workstreams
type:decision|d876e3|A choice the team must make (may become an ADR)
type:bug|d73a4a|Something broken
needs-human|e11d21|Agents could not converge - a human must decide
hub|000000|Pinned coordination hub (SYNC comments only)
EOF
  local hub; hub="$(hub_number)"
  if [ -z "$hub" ]; then
    local body
    body="Pinned. Agents post **SYNC** one-liners here at the start of a session and
whenever their focus changes (\`coord.sh hub \"...\"\`). Read the last few before
starting work.

Protocol: \`.claude/skills/coordinate/SKILL.md\` - Claude Code users run
\`/coordinate sync\`; any agent with \`gh\` can follow \`references/protocol.md\`.

Board: \`coord.sh board\` - or filter issues by \`ws:*\`, \`status:*\`, \`p0\`,
\`needs-human\`."
    hub="$(gh issue create --repo "$REPO" --title "$HUB_TITLE" --label hub --body "$body")"
    hub="${hub##*/}"
    gh issue pin "$hub" --repo "$REPO" >/dev/null 2>&1 || true
    echo "  hub    #$hub created and pinned"
  else
    echo "  hub    #$hub exists"
  fi
}

cmd_board() {
  gh issue list --repo "$REPO" --state open --limit 100 \
    --json number,title,labels,assignees,body --jq '
    .[] | select((.labels|map(.name)|index("hub"))|not)
    | (.labels|map(.name)) as $l
    | [ "#\(.number)",
        (($l|map(select(startswith("status:")))|.[0] // "status:unclaimed")|ltrimstr("status:")),
        (($l|map(select(startswith("ws:")))|.[0] // "ws:-")|ltrimstr("ws:")),
        (($l|map(select(test("^p[0-2]$")))|.[0] // "-")),
        ((.assignees|map("@"+.login)|join(",")) | if . == "" then "-" else . end),
        .title,
        ((.body // "" | [match("## Files\\n([^#]*)")] | .[0].captures[0].string // "")
          | gsub("\n";" ") | gsub("_\\(none listed\\)_";"") | .[0:48])
      ] | @tsv' \
  | sort -t "$(printf '\t')" -k4,4 -k3,3 \
  | awk -F '\t' 'BEGIN{printf "%-6s %-12s %-15s %-3s %-22s %-44s %s\n","ISSUE","STATUS","WS","P","OWNER","TITLE","FILES"}
                 {printf "%-6s %-12s %-15s %-3s %-22s %-44.44s %s\n",$1,$2,$3,$4,$5,$6,$7}'
}

cmd_stale() {
  gh issue list --repo "$REPO" --state open --limit 100 \
    --json number,title,assignees,comments --jq "
    .[] | select(.assignees|length>0)
    | (([.comments[] | select(.body|test(\"$HEARTBEAT\")) | .createdAt | fromdateiso8601] | max) // 0) as \$t
    | select(\$t == 0 or (now - \$t) > ($STALE_MIN*60))
    | \"#\(.number)\t\(.assignees|map(\"@\"+.login)|join(\",\"))\t\(if \$t==0 then \"no heartbeat\" else ((now-\$t)/60|floor|tostring)+\"m silent\" end)\t\(.title)\"" \
  | awk -F '\t' '{printf "%-6s %-22s %-14s %s\n",$1,$2,$3,$4}'
}

cmd_sync() {
  echo "== board ($REPO) =="; cmd_board
  echo; echo "== yours (@$ME) =="
  gh issue list --repo "$REPO" --assignee "@me" --state open --json number,title,labels \
    --jq '.[] | "#\(.number) \(.title)  [\([.labels[].name | select(startswith("status:"))] | join(","))]"' \
    | sed 's/^/  /'
  echo; echo "== stale claims (> ${STALE_MIN}m) =="; cmd_stale | sed 's/^/  /'
  echo; echo "== needs-human =="
  gh issue list --repo "$REPO" --label needs-human --state open --json number,title \
    --jq '.[] | "  #\(.number) \(.title)"'
  local hub; hub="$(hub_number)"
  if [ -n "$hub" ]; then
    echo; echo "== hub #$hub, last 5 SYNC =="
    gh issue view "$hub" --repo "$REPO" --json comments --jq '
      [.comments[] | select(.body|startswith("**SYNC**"))] | .[-5:] | .[]
      | "  \(.createdAt[11:16]) \(.body | split("\n")[0] | sub("\\*\\*SYNC\\*\\* \\| agent: ";"") | sub(" \\| at: .*";""))\n     \(.body | split("\n")[2:] | join(" "))"'
  else
    echo; echo "(no hub issue; run: coord.sh setup)"
  fi
}

cmd_hub() {
  parse "$@"; local text="${POS[0]:-}"; [ -n "$text" ] || die 'hub "on / blocked / next"'
  local hub; hub="$(hub_number)"; [ -n "$hub" ] || die "no hub issue; run: coord.sh setup"
  comment "$hub" SYNC "$text"
}

cmd_new() {
  parse "$@"
  local title="${POS[0]:-}"; [ -n "$title" ] || die 'new "title" --ws <slice> [...]'
  local ws="${OPT_ws:-}"
  [ -n "$ws" ] || die "--ws is required: os-shell|agent-chat|runtime-engine|persistence|integration|docs"
  local p="${OPT_p:-1}"; p="${p#p}"
  local type="${OPT_type:-task}"; type="${type#type:}"
  local done_items="" i
  if [ -n "${OPT_done:-}" ]; then
    IFS=';' read -ra items <<<"$OPT_done"
    for i in "${items[@]}"; do done_items+="- [ ] ${i# }"$'\n'; done
  else
    done_items="- [ ] "$'\n'
  fi
  local body="## Goal
${OPT_body:-$title}

## Done when
${done_items}
## Files
${OPT_files:-_(none listed)_}

## Depends on
${OPT_depends:-_(none)_}

## Notes
_(created by ${AGENT} for @${ME} at $(now))_
"
  local url
  url="$(gh issue create --repo "$REPO" --title "$title" --body "$body" \
         --label "ws:$ws" --label "p$p" --label "type:$type" --label "status:unclaimed")"
  local n="${url##*/}"
  echo "#$n $url"
  if [ -n "${FLAG_claim:-}" ]; then
    cmd_claim "$n" --plan "${OPT_plan:-}" --eta "${OPT_eta:-}"
  fi
}

cmd_claim() {
  parse "$@"; need_issue
  local owners; owners="$(assignees_of "$N" | tr '\n' ' ')"
  case " $owners" in *" $ME "*) note "#$N is already yours"; return 0 ;; esac
  if [ -n "${owners// /}" ]; then
    die "#$N is held by @${owners% } - use: propose $N \"split: ...\"  or  question $N \"...\""
  fi
  # v3 file scope: a claim must declare a non-empty Files scope.
  local scope; scope="$(files_of "$N")"
  if [ -z "$scope" ]; then
    die "#$N declares no Files scope - add a '## Files' section (coord new --files) before claiming"
  fi
  # v3 file scope: refuse active overlap unless the issue records a split or shares an owner.
  local o their clash common
  while IFS=$'\t' read -r o _; do
    [ -n "$o" ] || continue
    [[ "$o" =~ ^[0-9]+$ ]] || continue
    their="$(files_of "$o")"
    [ -n "$their" ] || continue
    clash="$(while read -r p; do
      [ -z "$p" ] && continue
      scopes_clash "$p" "$their" && echo "$p"
    done <<< "$scope" || true)"
    [ -n "$clash" ] || continue
    if gh issue view "$o" --repo "$REPO" --json body --jq '.body // ""' | grep -qE '^(\^)?split:'; then
      continue
    fi
    common=""
    for w in $owners; do
      assignees_of "$o" | grep -qx "$w" && { common="$w"; break; }
    done
    [ -n "$common" ] && continue
    die "#$N scope overlaps #$o on: $(printf '%s' "$clash" | paste -sd, -) - record a split on one of the issues or hand off ownership first"
  done < <(gh issue list --repo "$REPO" --state open --limit 100 --json number,labels,body \
             --jq '.[] | select(((.labels // []) | map(.name) | index("hub")) | not) | select(.number != '"$N"') | "\(.number)\t\(.body // "")"')
  comment "$N" CLAIM "plan: ${OPT_plan:-_(none given)_}"$'\n'"eta: ${OPT_eta:-_(none given)_}"
  gh issue edit "$N" --repo "$REPO" --add-assignee "@me" >/dev/null
  set_status "$N" claimed
  sleep 2
  local all; all="$(assignees_of "$N")"
  if [ "$(printf '%s\n' "$all" | grep -c .)" -gt 1 ]; then
    local list winner
    list="$(printf '%s\n' "$all" | sed 's/.*/"&"/' | paste -sd, -)"
    winner="$(gh issue view "$N" --repo "$REPO" --json comments --jq \
      "[.comments[] | select(.body|startswith(\"**CLAIM**\")) | select(.author.login as \$a | [$list] | index(\$a))]
       | sort_by(.createdAt) | .[0].author.login")"
    if [ "$winner" != "$ME" ]; then
      gh issue edit "$N" --repo "$REPO" --remove-assignee "@me" >/dev/null
      comment "$N" RELEASE "lost claim race to @$winner (earlier CLAIM); backing off"
      die "#$N was claimed simultaneously by @$winner - they keep it"
    fi
    note "claim race on #$N: your CLAIM is earliest; the other claimant's script will back off"
  fi
  echo "#$N claimed by @$ME"
}

cmd_release() {
  parse "$@"; need_issue
  local owners; owners="$(assignees_of "$N")"
  if [ -n "${FLAG_stale:-}" ]; then
    [ -n "$owners" ] || die "#$N has no assignee"
    is_stale "$N" || die "#$N had a heartbeat within ${STALE_MIN}m - not stale; ask the owner"
    local o; for o in $owners; do gh issue edit "$N" --repo "$REPO" --remove-assignee "$o" >/dev/null; done
    comment "$N" RELEASE "stale claim released: no heartbeat for >${STALE_MIN}m. previous owner(s): $(printf '%s\n' "$owners" | sed 's/^/@/' | paste -sd' ' -). reason: ${OPT_reason:-none given}"
  else
    printf '%s\n' "$owners" | grep -qx "$ME" || die "#$N is not yours; use --stale if it is abandoned"
    gh issue edit "$N" --repo "$REPO" --remove-assignee "@me" >/dev/null
    comment "$N" RELEASE "reason: ${OPT_reason:-none given}"
  fi
  set_status "$N" unclaimed
}

cmd_status() {
  parse "$@"; need_issue; local text="${POS[1]:-}"; [ -n "$text" ] || die 'status N "progress; next"'
  comment "$N" STATUS "$text"
  has_label "$N" status:claimed && set_status "$N" in-progress
  return 0
}

cmd_block() {
  parse "$@"; need_issue; local text="${POS[1]:-}"
  [ -n "${OPT_by:-}" ] || die 'block N --by "#m or @user" "what you need"'
  comment "$N" BLOCKED "by: ${OPT_by}"$'\n'"${text:-_(no detail)_}"
  set_status "$N" blocked
}

cmd_unblock() {
  parse "$@"; need_issue
  comment "$N" UNBLOCKED "${POS[1]:-_(no detail)_}"
  set_status "$N" in-progress
}

cmd_question() {
  parse "$@"; need_issue; local text="${POS[1]:-}"; [ -n "$text" ] || die 'question N [--to @u] [--human] "text"'
  local to=""; [ -n "${OPT_to:-}" ] && to="to: ${OPT_to}"$'\n'
  comment "$N" QUESTION "${to}${text}"
  [ -n "${FLAG_human:-}" ] && gh issue edit "$N" --repo "$REPO" --add-label needs-human >/dev/null
  return 0
}

cmd_answer() {
  parse "$@"; need_issue; local text="${POS[1]:-}"; [ -n "$text" ] || die 'answer N "text"'
  comment "$N" ANSWER "$text"
  gh issue edit "$N" --repo "$REPO" --remove-label needs-human >/dev/null 2>&1 || true
}

cmd_propose() {
  parse "$@"; need_issue; local text="${POS[1]:-}"; [ -n "$text" ] || die 'propose N [--to @u] "one concrete proposal"'
  local to=""; [ -n "${OPT_to:-}" ] && to="to: ${OPT_to}"$'\n'
  comment "$N" PROPOSE "${to}${text}"
}

cmd_accept() {
  parse "$@"; need_issue
  comment "$N" ACCEPT "${POS[1]:-accepted}"
  if has_label "$N" type:contract; then
    local proposal body
    proposal="$(gh issue view "$N" --repo "$REPO" --json comments --jq '
      [.comments[] | select(.body|startswith("**PROPOSE**") or startswith("**COUNTER**"))]
      | last | .body | split("\n")[2:] | join("\n")')"
    [ -n "$proposal" ] || { note "no proposal found to record"; return 0; }
    body="$(gh issue view "$N" --repo "$REPO" --json body --jq .body)"
    gh issue edit "$N" --repo "$REPO" --body "$body

## Agreed
_(accepted by @$ME via $AGENT at $(now))_

$proposal" >/dev/null
    echo "#$N contract recorded under ## Agreed"
  fi
}

cmd_counter() {
  parse "$@"; need_issue; local text="${POS[1]:-}"; [ -n "$text" ] || die 'counter N "revised proposal"'
  local rounds
  rounds="$(gh issue view "$N" --repo "$REPO" --json comments --jq \
    '[.comments[] | select(.body|startswith("**PROPOSE**") or startswith("**COUNTER**"))] | length')"
  if [ "$rounds" -ge 3 ]; then
    text="$text"$'\n\n'"Escalating: this is round $((rounds + 1)) without agreement. $(mention_humans "$N") please decide."
    gh issue edit "$N" --repo "$REPO" --add-label needs-human >/dev/null
    note "#$N escalated to needs-human"
  fi
  comment "$N" COUNTER "$text"
}

cmd_reject() {
  parse "$@"; need_issue; local text="${POS[1]:-}"; [ -n "$text" ] || die 'reject N "reason"'
  comment "$N" REJECT "$text"
}

cmd_handoff() {
  parse "$@"; need_issue
  local to="${OPT_to:-}"; [ -n "$to" ] || die 'handoff N --to @user "context"'
  to="${to#@}"
  comment "$N" HANDOFF "to: @$to"$'\n'"${POS[1]:-_(no context given)_}"
  is_mine "$N" && gh issue edit "$N" --repo "$REPO" --remove-assignee "@me" >/dev/null
  gh issue edit "$N" --repo "$REPO" --add-assignee "$to" >/dev/null
  set_status "$N" claimed
}

cmd_review() {
  parse "$@"; need_issue
  [ -n "${OPT_pr:-}" ] || die 'review N --pr URL ["text"]'
  [[ "$OPT_pr" =~ /pull/([0-9]+) ]] || die "--pr must be a pull-request URL: $OPT_pr"
  local prn="${BASH_REMATCH[1]}"
  # v3 file scope: PR paths must fall within the union of linked issues' Files.
  local body allowed linked prbody
  body="$(gh issue view "$N" --repo "$REPO" --json body --jq '.body // ""')"
  # Multi-issue PRs: union scopes from cross-references in the issue body and the PR's Closes list.
  prbody="$(gh pr view "$prn" --repo "$REPO" --json body --jq '.body // ""')"
  linked="$N $(referenced_issues "$body") $(referenced_issues "$prbody")"
  allowed="$( { for l in $linked; do files_of "$l"; done; } | sort -u)"
  if [ -n "$allowed" ]; then
    local undeclared p
    undeclared="$(gh pr view "$prn" --repo "$REPO" --json files --jq '.files[].path' |
      while read -r p; do
        path_in_scope "$p" "$allowed" || echo "$p"
      done)"
    if [ -n "$undeclared" ]; then
      die "PR #$prn touches paths outside the linked issues' Files scope: $(printf '%s' "$undeclared" | paste -sd, -) - update the issues' Files or drop the paths"
    fi
  fi
  comment "$N" REVIEW "pr: ${OPT_pr}"$'\n'"${POS[1]:-}"
  set_status "$N" in-review
}

cmd_done() {
  parse "$@"; need_issue
  # v3 completion: refuse while a Done-when box is unchecked or the linked PR is unmerged.
  local body prurl
  body="$(gh issue view "$N" --repo "$REPO" --json body --jq '.body // ""')"
  if printf '%s' "$body" | grep -q '^## Done when' &&
     printf '%s' "$body" | grep -q '^[[:space:]]*-[[:space:]]*\[ \]'; then
    die "#$N still has unchecked '## Done when' criteria - check them off after verifying (caller attests)"
  fi
  prurl="${OPT_pr:-}"
  if [ -z "$prurl" ]; then
    prurl="$(gh issue view "$N" --repo "$REPO" --json comments --jq \
      '[.comments[] | select(.body|test("pr: \\S+/pull/\\d+"))] | last | (.body // "") | capture("pr: (?<u>\\S+/pull/\\d+)").u // empty')"
  fi
  if [ -n "$prurl" ]; then
    [[ "$prurl" =~ /pull/([0-9]+) ]] || die "cannot parse a PR number from: $prurl"
    local prn="${BASH_REMATCH[1]}" state
    state="$(gh pr view "$prn" --repo "$REPO" --json state --jq '.state')"
    [ "$state" = "MERGED" ] || die "PR #$prn is not merged yet - merge it before closing #$N"
  fi
  comment "$N" DONE "pr: ${prurl:-_(none given)_}"$'\n'"${POS[1]:-}"
  gh issue close "$N" --repo "$REPO" >/dev/null
  echo "#$N closed"
}

cmd_show() {
  parse "$@"; need_issue
  gh issue view "$N" --repo "$REPO" --json number,title,state,labels,assignees,body,comments --jq '
    "#\(.number) \(.title)  [\(.state)]",
    "labels:    \([.labels[].name] | join(", "))",
    "assignees: \([.assignees[].login] | map("@"+.) | join(", "))",
    "", .body, "", "---- protocol comments ----",
    (.comments[] | select(.body|test("^\\*\\*[A-Z-]+\\*\\*")) | "\n\(.createdAt)  \(.body)")'
}

# ---------- dispatch ----------
cmd="${1:-}"; [ $# -gt 0 ] && shift
case "$cmd" in
  hub|new|release|claim|show) MAX_POS=1 ;;
  board|sync|setup|stale) MAX_POS=0 ;;
  status|block|unblock|question|answer|propose|accept|counter|reject|handoff|review|done) MAX_POS=2 ;;
esac
case "$cmd" in
  setup|sync|board|hub|new|claim|release|status|block|unblock|question|answer|propose|accept|counter|reject|handoff|review|done|stale|show)
    "cmd_$cmd" "$@" ;;
  -h|--help|help|"") usage ;;
  *) usage; die "unknown command: $cmd" ;;
esac
