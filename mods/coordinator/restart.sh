#!/usr/bin/env bash
# Restarts an agent in its own tab, optionally as another agent. The new one
# starts beside the old one (same tab labels), gets a short handoff, then the
# old one ends, so the tab keeps its name and place. A coordinator restarted
# without an argv runs the assistant template again (edited instructions apply).
# Its workers get herdr.coordinator=<tab> so they stay nested under the new one.
# Usage: restart.sh <old address> [argv as JSON array]
# Prints the new agent's address.
# For the chat mod (mods/chat), two optional environment variables:
#   HERDR_RESTART_CHAT=<chat pane>  the new agent starts parked behind that chat pane
#                                   (herdr.chat label) instead of getting a pane in the tab.
#   HERDR_RESTART_RESUME=1          argv resumes the same conversation: no handoff is sent.
set -u
old=$1 argv=${2:-}
info=$(hc get "$old" --json) || exit 1
get() { jq -r "$1 // empty" <<<"$info"; }
space=$(get '.labels["herdr.space"]') tab=$(get '.labels["herdr.tab"]') role=$(get '.labels["herdr.role"]')
# Assistants start from the assistant template (earlier ones from "coordinator").
case $(get .template) in assistant|coordinator) role=coordinator ;; esac
cwd=$(get .cwd) app=$(get .status.app) pid=$(get .foreground.pid) created=$(get .created_ms)
# An Assistant that ran omp starts again from the fork's omp template (docs/OMP-FORK.md).
tpl=assistant; [ "$app" = omp ] || [ "$(get .foreground.name)" = omp ] && tpl=assistant-omp
# A parked agent (behind a chat) has no tab labels: the chat names where it goes instead.
# A coordinator in Chat mode says where it lives in its own labels (its workers name that tab).
[ -n "$tab" ] || tab=$(get '.labels["herdr.coordinator.tab"]')
[ -n "$space" ] && [ -n "$tab" ] || [ -n "${HERDR_RESTART_CHAT:-}" ] || [ -n "$(get '.labels["herdr.chat"]')" ] || exit 1

# What the previous agent did: its screen, and its session log when we can find it.
dir=${HERDR_APP_HOME:-$HOME/.config/herdr-app}/data/coordinator/handoff
mkdir -p "$dir"
screen="$dir/$old-$(date +%s).txt"
hc read "$old" --lines 400 >"$screen" 2>/dev/null
log=""
if [ "$app" = claude-code ] && [ -n "$pid" ]; then
  sid=$(jq -r '.sessionId // empty' "$HOME/.claude/sessions/$pid.json" 2>/dev/null)
  [ -n "$sid" ] && log=$(find "$HOME/.claude/projects" -name "$sid.jsonl" 2>/dev/null | head -1)
fi
if [ -z "$log" ] && [ -n "$created" ]; then
  log=$(find "$HOME/.claude/projects" "$HOME/.codex/sessions" "$HOME/.pi/agent/sessions" "$HOME/.local/share/opencode" \
      -type f \( -name '*.jsonl' -o -name '*.json' \) -newermt "@$((created / 1000))" 2>/dev/null \
    | xargs -r grep -l -F "\"$cwd\"" 2>/dev/null | xargs -r ls -t 2>/dev/null | head -1)
fi
was=${app:-the previous agent}
handoff="You are taking over this tab from $was ($old), which was restarted."
[ -n "$log" ] && handoff+=" Its session log is $log: read the recent part to pick up where it left off."
handoff+=" Its last screen is saved in $screen."

if [ "$role" = coordinator ]; then
  workers=$( { hc ls --json | jq -r --arg c "$old" '.terminals[] | select(.parent == $c) | .address'
    hc ls --json --label "herdr.coordinator=$tab" | jq -r --arg c "$old" '.terminals[] | select(.address != $c) | .address'; } | sort -u)
  if [ -n "$workers" ]; then
    list=""
    for w in $workers; do
      hc label "$w" "herdr.coordinator=$tab" >/dev/null 2>&1
      list+=" $w ($(hc get "$w" --json | jq -r '.name // .labels.where // ""'))"
    done
    handoff+=" Workers the previous coordinator started, still running:$list. They report to $old: watch each with hc wait <t> and tell each to report to you from now on."
  fi
fi

labels=(--label "herdr.space=$space" --label "herdr.tab=$tab")
[ "$role" = coordinator ] && labels+=(--label herdr.role=coordinator)
# An agent in Chat mode (parked behind a chat pane) restarts parked behind the same chat.
chat=${HERDR_RESTART_CHAT:-$(get '.labels["herdr.chat"]')}
if [ -n "$chat" ]; then
  origin=$(get '.labels["herdr.chat.origin"]'); origin=${origin:-$old}
  labels=(--keep --label "herdr.chat=$chat" --label "herdr.chat.origin=$origin")
  # What a coordinator chat finds its agent by (mods/chat), and where the coordinator lives.
  for k in herdr.chat.slot herdr.coordinator.space herdr.coordinator.tab; do
    v=$(get ".labels[\"$k\"]"); [ -n "$v" ] && labels+=(--label "$k=$v")
  done
  [ "$role" = coordinator ] && labels+=(--label herdr.role=coordinator)
fi
if [ -n "${HERDR_RESTART_RESUME:-}" ] && [ -n "$argv" ]; then
  mapfile -t cmd < <(jq -r '.[]' <<<"$argv")
  [ ${#cmd[@]} -gt 0 ] || exit 1
  # omp appends the same session file it resumes (docs/OMP-FORK.md): the old process must be
  # gone before the new one starts — never two omp on one file. Other CLIs start beside the old.
  if [ "$(basename "${cmd[0]}")" = omp ] && [ "$(jq -r '.state // empty' <<<"$info")" = live ]; then
    oldpid=$(jq -r '.foreground.pid // empty' <<<"$info")
    hc kill "$old" >/dev/null 2>&1
    i=0; while [ -n "$oldpid" ] && kill -0 "$oldpid" 2>/dev/null && [ "$i" -lt 150 ]; do sleep 0.1; i=$((i+1)); done
  fi
  new=$(hc run --bg --json --no-parent --cwd "$cwd" "${labels[@]}" --label "herdr.agent=$(basename "${cmd[0]}")" -- "${cmd[@]}" | jq -r '.address // empty')
elif [ -z "$argv" ] && [ "$role" = coordinator ]; then
  new=$(hc run --bg --json --no-parent --cwd "$cwd" "${labels[@]}" "$tpl" "$handoff" | jq -r .address)
else
  mapfile -t cmd < <(jq -r '.[]' <<<"$argv")
  [ ${#cmd[@]} -gt 0 ] || exit 1
  key=$(basename "${cmd[0]}")
  # Codex runs its commands outside hc without --no-daemon.
  [ "$key" = codex ] && [[ " ${cmd[*]} " != *" --no-daemon "* ]] && cmd+=(--no-daemon)
  msg=$handoff
  if [ "$role" = coordinator ]; then
    body=$(awk 'f>=2 {print} /^---[[:space:]]*$/ {f++}' "$HOME/.config/herdr-core/templates/$tpl.md")
    msg="$body"$'\n\n'"$handoff"
  fi
  # hc delivers a template's first message once the agent is ready, so the
  # handoff goes in a one-off template, removed once it has started.
  one=herdr-handoff-$$
  file=$HOME/.config/herdr-core/templates/$one.md
  { printf -- '---\nname: %s\ndescription: A one-off Herdr handoff, removed after use.\ncommand: %s\n---\n' "$one" "$(printf '%q ' "${cmd[@]}")"
    printf '%s\n' "$msg"; } >"$file"
  out=$(hc run --bg --json --no-parent --cwd "$cwd" "${labels[@]}" --label "herdr.agent=$key" "$one")
  rm -f "$file"
  new=$(jq -r '.address // empty' <<<"$out")
  # Some agents (Codex's animated start) never settle for hc: send once it reports a status.
  if [ -n "$new" ] && [ "$(jq -r '.first_message.sent' <<<"$out")" = false ]; then
    hc wait "$new" --timeout 90 >/dev/null 2>&1
    hc send "$new" "$msg" >/dev/null 2>&1
  fi
fi
[ -n "$new" ] || exit 1
hc kill "$old" >/dev/null 2>&1
hc rm "$old" >/dev/null 2>&1
echo "$new"
exit 0
