#!/usr/bin/env bash
# Drives coder/ai-sdk's public packages against a live Coder deployment and
# keeps the evidence. See SKILL.md next to this file.
#
# Usage, from anywhere in the repository:
#   verify.sh launch                 install dependencies (frozen lockfile) and build every package
#   verify.sh doctor                 read-only checks: toolchain, checkout, deployment, auth, models
#   verify.sh features               list the mapped features
#   verify.sh drive <feature>...     drive features; prints the run directory and PASS/FAIL per check
#   verify.sh cleanup <run-dir> [--candidates]
#                                    archive the chats that the run recorded and that are still
#                                    unarchived; --candidates also archives possibly leaked chats
#
# Needs CODER_URL and CODER_SESSION_TOKEN. Never prints the token.
# Evidence goes to $VERIFY_OUT/<run-id>/<feature>/ (default
# ${XUM_SCRATCH_DIR:-$TMPDIR}/verify-coder-ai-sdk). Cleanup never deletes it.
set -euo pipefail

SKILL="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(git -C "$SKILL" rev-parse --show-toplevel)"
cd "$ROOT"
if command -v mise >/dev/null 2>&1; then
  PATH="$(mise where node)/bin:$(dirname "$(mise which pnpm)"):$PATH"
fi
OUT_ROOT="${VERIFY_OUT:-${XUM_SCRATCH_DIR:-${TMPDIR:-/tmp}}/verify-coder-ai-sdk}"
DRIVE_TIMEOUT="${VERIFY_TIMEOUT:-300}"
FEATURES=(agent-generate agent-stream agent-custom-tool agent-multi-turn provider-generate-stream)

die() {
  echo "verify.sh: $*" >&2
  exit 2
}
need_env() {
  [ -n "${CODER_URL:-}" ] || die "CODER_URL is not set"
  [ -n "${CODER_SESSION_TOKEN:-}" ] || die "CODER_SESSION_TOKEN is not set"
  CODER_URL="${CODER_URL%/}"
}
# GET or PATCH against the deployment. Writes the body to $2, prints the HTTP status.
api() {
  local method="$1" out="$2" path="$3" body="${4:-}"
  local args=(-sS -o "$out" -w '%{http_code}' -X "$method" -H "Coder-Session-Token: $CODER_SESSION_TOKEN")
  if [ -n "$body" ]; then args+=(-H 'Content-Type: application/json' --data "$body"); fi
  curl "${args[@]}" "$CODER_URL$path"
}
strip_ansi() { sed 's/\x1b\[[0-9;]*m//g'; }

cmd_launch() {
  if command -v mise >/dev/null 2>&1; then
    # Only the two runtime tools: a bare `mise install` also tries global tools.
    mise install node pnpm
    PATH="$(mise where node)/bin:$(dirname "$(mise which pnpm)"):$PATH"
  fi
  CI=true pnpm install --frozen-lockfile
  pnpm -r build
  echo "launch: ok. Next: verify.sh doctor"
}

cmd_doctor() {
  local ok=1 tmp
  tmp="$(mktemp -d)"
  check() { # check <PASS|FAIL> <message>
    echo "$1 $2"
    if [ "$1" = FAIL ]; then ok=0; fi
  }
  local want_node want_pnpm
  want_node="v$(sed -n 's/^node = "\(.*\)"/\1/p' mise.toml)"
  want_pnpm="$(sed -n 's/.*"packageManager": "pnpm@\(.*\)".*/\1/p' package.json)"
  if [ "$(node --version)" = "$want_node" ]; then check PASS "node $want_node (mise.toml)"; else check FAIL "node $(node --version), mise.toml pins $want_node"; fi
  if [ "$(pnpm --version)" = "$want_pnpm" ]; then check PASS "pnpm $want_pnpm"; else check FAIL "pnpm $(pnpm --version), package.json pins $want_pnpm"; fi
  for tool in curl jq timeout; do
    if command -v "$tool" >/dev/null; then check PASS "$tool on PATH"; else check FAIL "$tool missing"; fi
  done
  for pkg in agent provider; do
    if [ -x "packages/$pkg/node_modules/.bin/tsx" ]; then check PASS "packages/$pkg dependencies installed"; else check FAIL "packages/$pkg/node_modules missing: run verify.sh launch"; fi
  done
  local dirty=" (packages/ clean)"
  git diff --quiet HEAD -- packages || dirty=" (local changes under packages/)"
  check PASS "checkout $(git rev-parse --short HEAD) on $(git rev-parse --abbrev-ref HEAD)$dirty"

  if [ -z "${CODER_URL:-}" ] || [ -z "${CODER_SESSION_TOKEN:-}" ]; then
    check FAIL "CODER_URL and CODER_SESSION_TOKEN must both be set"
    echo "doctor: NOT READY"
    return 1
  fi
  CODER_URL="${CODER_URL%/}"
  local status
  status="$(api GET "$tmp/buildinfo.json" /api/v2/buildinfo || true)"
  if [ "$status" = 200 ]; then check PASS "deployment $CODER_URL runs $(jq -r .version "$tmp/buildinfo.json")"; else check FAIL "GET /api/v2/buildinfo -> $status"; fi
  status="$(api GET "$tmp/me.json" /api/v2/users/me || true)"
  local org=""
  if [ "$status" = 200 ]; then
    org="${CODER_ORG_ID:-$(jq -r '.organization_ids[0] // empty' "$tmp/me.json")}"
    check PASS "token valid: user $(jq -r .username "$tmp/me.json"), organization ${org:-none}"
  else
    check FAIL "GET /api/v2/users/me -> $status (token invalid or expired)"
  fi
  status="$(api GET "$tmp/chats.json" '/api/v2/chats?limit=1' || true)"
  if [ "$status" = 200 ]; then check PASS "Coder Agents chat API answers (GET /api/v2/chats)"; else check FAIL "GET /api/v2/chats -> $status: Coder Agents is not available to this user"; fi
  if [ -n "$org" ]; then
    status="$(api GET "$tmp/models.json" "/api/v2/organizations/$org/chats/models" || true)"
    if [ "$status" = 200 ]; then
      local hint
      for hint in "${CODER_MODEL:-haiku}" "${CODER_TOOL_MODEL:-sonnet}"; do
        if jq -e --arg h "$hint" '[.models[]? | ((.display_name // "") + " " + (.model // "") + " " + (.id // "")) | ascii_downcase | contains($h | ascii_downcase)] | any' "$tmp/models.json" >/dev/null; then
          check PASS "agent model hint \"$hint\" matches an enabled chat model"
        else
          check FAIL "agent model hint \"$hint\" matches no chat model (set CODER_MODEL / CODER_TOOL_MODEL)"
        fi
      done
    else
      check FAIL "GET /api/v2/organizations/$org/chats/models -> $status"
    fi
  fi
  rm -rf "$tmp"
  if [ "$ok" = 1 ]; then echo "doctor: READY"; else echo "doctor: NOT READY"; return 1; fi
}

# --- drive helpers -----------------------------------------------------------

# run_example <feature-dir> <package> <example> [VAR=value...] : runs one example
# script with extra environment, keeps its output, prints its exit code.
run_example() {
  local dir="$1" pkg="$2" example="$3" name
  shift 3
  name="$(basename "$example" .ts)"
  echo "cd packages/$pkg && ${*:+$* }pnpm exec tsx $example" >>"$dir/command.txt"
  local code=0
  (cd "packages/$pkg" && env "$@" timeout "$DRIVE_TIMEOUT" pnpm exec tsx "$example") \
    >"$dir/$name.stdout.txt" 2>"$dir/$name.stderr.txt" || code=$?
  strip_ansi <"$dir/$name.stdout.txt" >"$dir/$name.clean.txt"
  echo "$code" >"$dir/$name.exit-code.txt"
  echo "$code"
}

# record_chat <feature-dir> <chat-id> : saves the chat and its messages (second view) and the id.
record_chat() {
  local dir="$1" id="$2"
  echo "$id" >>"$dir/chat-ids.txt"
  api GET "$dir/chat-$id.json" "/api/v2/chats/$id" >/dev/null
  api GET "$dir/messages-$id.json" "/api/v2/chats/$id/messages?limit=100" >/dev/null
}

# The value printed after "<label> :" up to the next "Label :" line (multi-line text).
field_block() {
  awk -v label="$1" '
    $0 ~ "^" label " *: " { on = 1; sub("^" label " *: ", ""); print; next }
    on && /^[A-Z][A-Za-z ]* *: / { on = 0 }
    on { print }
  ' "$2"
}

# Assistant text of a chat, in message id order, from the saved messages.
committed_text() {
  jq -r '[.messages | sort_by(.id)[] | select(.role == "assistant") | .content[]? | select(.type == "text") | .text] | join("")' "$1"
}

# Unarchived chats created since <start> whose first user message is <prompt>:
# chats that this drive may have leaked when the example died before it printed an id.
find_candidates() {
  local dir="$1" start="$2" prompt="$3" id
  api GET "$dir/.chats-after.json" '/api/v2/chats?limit=50' >/dev/null || return 0
  for id in $(jq -r --arg s "$start" '.[]? | select(.archived == false and .created_at >= $s) | .id' "$dir/.chats-after.json"); do
    grep -qx "$id" "$dir/chat-ids.txt" 2>/dev/null && continue
    api GET "$dir/.candidate.json" "/api/v2/chats/$id/messages?limit=100" >/dev/null || continue
    if jq -e --arg p "$prompt" '[.messages | sort_by(.id)[] | select(.role == "user")][0].content[]? | select(.type == "text" and .text == $p)' "$dir/.candidate.json" >/dev/null; then
      echo "$id" >>"$dir/leaked-candidates.txt"
      echo "WARN possibly leaked chat $id (archive: verify.sh cleanup $(dirname "$dir") --candidates)"
    fi
  done
  rm -f "$dir/.chats-after.json" "$dir/.candidate.json"
}

FAILED=0
# check_that <message> <command...> : PASS when the command succeeds. Appends to checks.txt.
check_that() {
  local message="$1" verdict=FAIL
  shift
  if "$@" >/dev/null 2>&1; then verdict=PASS; fi
  echo "$verdict $message" | tee -a "$CHECKS"
  if [ "$verdict" = FAIL ]; then FAILED=1; fi
}
# answer_mentions <example-output> <word> : the Answer block contains the word.
# A digit or "-" next to it is not a match, so "20-sided" does not count as the value 20.
answer_mentions() { [ -n "$2" ] && field_block Answer "$1" | grep -Eq -- "(^|[^0-9-])$2([^0-9-]|$)"; }
is_true() { [ "$(jq -r "$2" "$1" 2>/dev/null)" = true ]; }

# --- features -----------------------------------------------------------------

drive_agent_generate() {
  local dir="$1" code id answer out
  code="$(run_example "$dir" agent examples/01-generate.ts "CODER_MODEL=${CODER_MODEL:-haiku}")"
  out="$dir/01-generate.clean.txt"
  check_that "example exits 0 (got $code)" [ "$code" = 0 ]
  id="$(sed -n 's/^Chat id *: //p' "$out")"
  answer="$(field_block Answer "$out")"
  check_that "generate() returned text" [ -n "$answer" ]
  check_that "finish reason is stop" grep -q '^Finish reason: stop$' "$out"
  if [ -z "$id" ]; then check_that "example printed a chat id" false; return; fi
  record_chat "$dir" "$id"
  committed_text "$dir/messages-$id.json" >"$dir/committed-text.txt"
  check_that "result.text equals the assistant text that chatd committed" [ "$(cat "$dir/committed-text.txt")" = "$answer" ]
  check_that "the example archived its chat" is_true "$dir/chat-$id.json" .archived
}

drive_agent_stream() {
  local dir="$1" code id streamed out
  code="$(run_example "$dir" agent examples/02-stream.ts "CODER_MODEL=${CODER_MODEL:-haiku}")"
  out="$dir/02-stream.clean.txt"
  check_that "example exits 0 (got $code)" [ "$code" = 0 ]
  # The deltas sit between the heading and the "Steps" line, framed by blank lines.
  streamed="$(awk '/^=== stream\(\) ===$/{on=1; next} /^Steps +:/{on=0} on' "$out" | sed '/^$/d')"
  printf '%s' "$streamed" >"$dir/streamed-text.txt"
  check_that "textStream produced text" [ -n "$streamed" ]
  check_that "finish reason is stop" grep -q '^Finish reason: stop$' "$out"
  id="$(sed -n 's/^Chat id *: //p' "$out")"
  if [ -z "$id" ]; then check_that "example printed a chat id" false; return; fi
  record_chat "$dir" "$id"
  committed_text "$dir/messages-$id.json" >"$dir/committed-text.txt"
  check_that "streamed text equals the committed text, exactly once" [ "$(sed '/^$/d' "$dir/committed-text.txt")" = "$streamed" ]
  check_that "the example archived its chat" is_true "$dir/chat-$id.json" .archived
}

drive_agent_custom_tool() {
  local dir="$1" code id rolls value out
  code="$(run_example "$dir" agent examples/03-custom-tool.ts "CODER_TOOL_MODEL=${CODER_TOOL_MODEL:-sonnet}")"
  out="$dir/03-custom-tool.clean.txt"
  check_that "example exits 0 (got $code)" [ "$code" = 0 ]
  rolls="$(grep -c '^  \[local tool\] rollDice' "$out" || true)"
  check_that "the local tool ran exactly once (ran $rolls times)" [ "$rolls" = 1 ]
  value="$(sed -n 's/^  \[local tool\] rollDice.* -> \([0-9]*\)$/\1/p' "$out" | head -1)"
  check_that "result.steps records the rollDice call" grep -q '^Tool calls *: rollDice(' "$out"
  check_that "the answer reports the rolled value ${value:-?}" answer_mentions "$out" "$value"
  id="$(sed -n 's/^Chat id *: //p' "$out")"
  if [ -z "$id" ]; then check_that "example printed a chat id" false; return; fi
  record_chat "$dir" "$id"
  check_that "chatd stored one rollDice tool call" jq -e '[.messages[].content[]? | select(.type == "tool-call" and .tool_name == "rollDice")] | length == 1' "$dir/messages-$id.json"
  check_that "chatd stored one rollDice tool result with value ${value:-?}" jq -e --arg v "${value:--1}" '[.messages[].content[]? | select(.type == "tool-result" and .tool_name == "rollDice") | (.result | if type == "string" then (fromjson? // {}) else . end) | .value == ($v | tonumber)] | length == 1 and all' "$dir/messages-$id.json"
  check_that "the example archived its chat" is_true "$dir/chat-$id.json" .archived
}

drive_agent_multi_turn() {
  local dir="$1" code ids id out
  code="$(run_example "$dir" agent examples/04-multi-turn.ts "CODER_MODEL=${CODER_MODEL:-haiku}")"
  out="$dir/04-multi-turn.clean.txt"
  check_that "example exits 0 (got $code)" [ "$code" = 0 ]
  ids="$(sed -n 's/^  chat: \([0-9a-f-]*\).*/\1/p' "$out" | sort -u)"
  check_that "both turns used one chat" [ "$(printf '%s\n' "$ids" | grep -c .)" = 1 ]
  check_that "turn 2 recalls the color from turn 1" grep -qi '^Turn 2:.*teal' "$out"
  id="$(printf '%s\n' "$ids" | head -1)"
  if [ -z "$id" ]; then check_that "example printed a chat id" false; return; fi
  record_chat "$dir" "$id"
  check_that "chatd stored both user turns in that chat" jq -e '[.messages[] | select(.role == "user")] | length == 2' "$dir/messages-$id.json"
  check_that "the example archived its chat" is_true "$dir/chat-$id.json" .archived
}

drive_provider_generate_stream() {
  local dir="$1" code out haiku
  # CODER_MODEL is a chat-model hint for the agent examples but a gateway model
  # id for the provider examples, so the provider drive sets its own.
  local model="CODER_MODEL=${VERIFY_PROVIDER_MODEL:-claude-sonnet-4-6}"
  code="$(run_example "$dir" provider examples/01-generate.ts "$model")"
  out="$dir/01-generate.clean.txt"
  check_that "generateText example exits 0 (got $code)" [ "$code" = 0 ]
  check_that "generateText returned text" grep -q '^Answer *: .' "$out"
  check_that "finish reason is stop" grep -q '^Finish reason: stop$' "$out"
  check_that "usage reports output tokens" grep -q '"outputTokens":[1-9]' "$out"
  code="$(run_example "$dir" provider examples/02-stream.ts "$model")"
  out="$dir/02-stream.clean.txt"
  check_that "streamText example exits 0 (got $code)" [ "$code" = 0 ]
  haiku="$(awk '/^=== streamText\(\)/{on=1; next} /^Usage +:/{on=0} on' "$out" | sed '/^$/d')"
  printf '%s\n' "$haiku" >"$dir/streamed-text.txt"
  check_that "textStream produced text" [ -n "$haiku" ]
  check_that "stream usage reports output tokens" grep -q '"outputTokens":[1-9]' "$out"
}

prompt_of() {
  case "$1" in
    agent-generate) echo "In one sentence, what is Coder?" ;;
    agent-stream) echo "Describe a sunrise over the mountains in three sentences." ;;
    agent-custom-tool) echo "Roll a 20-sided die using the tool, then tell me the number I rolled." ;;
    agent-multi-turn) echo "Remember that my favorite color is teal. Reply with just 'ok'." ;;
    *) echo "" ;;
  esac
}

cmd_drive() {
  need_env
  [ $# -gt 0 ] || die "drive needs at least one feature: ${FEATURES[*]}"
  local run feature
  run="$OUT_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-$$"
  mkdir -p "$run"
  api GET "$run/buildinfo.json" /api/v2/buildinfo >/dev/null || true
  {
    echo "commit: $(git rev-parse HEAD)$(git diff --quiet HEAD -- packages && echo ' (packages/ clean)' || echo ' + local changes under packages/')"
    echo "node: $(node --version)"
    echo "deployment: $CODER_URL $(jq -r '.version // "unknown"' "$run/buildinfo.json" 2>/dev/null)"
  } >"$run/run.txt"
  echo "run: $run"
  for feature in "$@"; do
    case " ${FEATURES[*]} " in *" $feature "*) ;; *) die "unknown feature $feature (known: ${FEATURES[*]})" ;; esac
    local dir="$run/$feature" start
    mkdir -p "$dir"
    CHECKS="$dir/checks.txt"
    start="$(date -u +%Y-%m-%dT%H:%M:%S)"
    echo "== $feature"
    "drive_${feature//-/_}" "$dir"
    if [ -n "$(prompt_of "$feature")" ]; then find_candidates "$dir" "$start" "$(prompt_of "$feature")"; fi
  done
  echo "evidence: $run"
  if [ "$FAILED" = 0 ]; then echo "drive: PASS"; else echo "drive: FAIL"; return 1; fi
}

cmd_cleanup() {
  need_env
  local run="${1:-}" include_candidates="${2:-}" id status tmp
  [ -d "$run" ] || die "cleanup needs the run directory that drive printed"
  tmp="$(mktemp)"
  local files=("$run"/*/chat-ids.txt)
  if [ "$include_candidates" = --candidates ]; then files+=("$run"/*/leaked-candidates.txt); fi
  for id in $(cat "${files[@]}" 2>/dev/null | sort -u); do
    api GET "$tmp" "/api/v2/chats/$id" >/dev/null
    if [ "$(jq -r .archived "$tmp")" = true ]; then
      echo "already archived: $id" | tee -a "$run/cleanup.txt"
      continue
    fi
    status="$(api PATCH "$tmp" "/api/v2/chats/$id" '{"archived":true}')"
    echo "archive $id -> HTTP $status" | tee -a "$run/cleanup.txt"
  done
  rm -f "$tmp"
  echo "cleanup: done; evidence kept in $run"
}

case "${1:-}" in
  launch) cmd_launch ;;
  doctor) cmd_doctor ;;
  features) printf '%s\n' "${FEATURES[@]}" ;;
  drive) shift; cmd_drive "$@" ;;
  cleanup) shift; cmd_cleanup "$@" ;;
  *) sed -n '2,17p' "$0"; exit 2 ;;
esac
