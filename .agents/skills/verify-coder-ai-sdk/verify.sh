#!/usr/bin/env bash
# Drives coder/ai-sdk's public packages against a live Coder deployment and
# keeps the evidence. See SKILL.md next to this file.
#
# Usage, from anywhere in the repository:
#   verify.sh launch                 install dependencies (frozen lockfile) and build every package
#   verify.sh doctor                 read-only checks: toolchain, checkout, deployment, auth, models
#   verify.sh features               list the mapped features
#   verify.sh drive <feature>...     drive features; prints the run directory and PASS/FAIL per check
#   verify.sh cleanup <run-dir>      archive the chats that the run's examples created and that
#                                    are still unarchived; exits 1 when an archive fails
#
# Needs CODER_URL and CODER_SESSION_TOKEN. Never prints the token.
# Evidence goes to $VERIFY_OUT/<run-id>/<feature>/ (default
# ${XUM_SCRATCH_DIR:-$TMPDIR}/verify-coder-ai-sdk). Cleanup never deletes it.
set -euo pipefail

SKILL="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(git -C "$SKILL" rev-parse --show-toplevel)"
# Relative paths in VERIFY_OUT and in `cleanup <run-dir>` mean the caller's directory.
CALLER_PWD="$PWD"
absolute() { case "$1" in /*) printf '%s' "$1" ;; *) printf '%s/%s' "$CALLER_PWD" "$1" ;; esac; }
cd "$ROOT"
# Put Node and pnpm from mise.toml first on PATH when mise has them installed.
# Before `launch` installs them, keep the ambient PATH: doctor reports it.
use_mise_toolchain() {
  command -v mise >/dev/null 2>&1 || return 0
  local node_dir pnpm_bin
  node_dir="$(mise where node 2>/dev/null)" || return 0
  pnpm_bin="$(mise which pnpm 2>/dev/null)" || return 0
  PATH="$node_dir/bin:$(dirname "$pnpm_bin"):$PATH"
}
use_mise_toolchain
OUT_ROOT="$(absolute "${VERIFY_OUT:-${XUM_SCRATCH_DIR:-${TMPDIR:-/tmp}}/verify-coder-ai-sdk}")"
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
# The token goes to curl on stdin as a config line, so it never shows in a process list.
api() {
  local method="$1" out="$2" path="$3" body="${4:-}"
  local args=(-sS -K - -o "$out" -w '%{http_code}' -X "$method")
  if [ -n "$body" ]; then args+=(-H 'Content-Type: application/json' --data "$body"); fi
  printf 'header = "Coder-Session-Token: %s"\n' "$CODER_SESSION_TOKEN" | curl "${args[@]}" "$CODER_URL$path"
}
strip_ansi() { sed 's/\x1b\[[0-9;]*m//g'; }

# The chat route prefix, as CoderChatClient picks it: the v2 route, or the
# legacy route when v2 answers 404. Sets CHAT_PREFIX and CHAT_PROBE_STATUS.
CHAT_PREFIX=/api/v2/chats
CHAT_PROBE_STATUS=""
pick_chat_prefix() {
  local tmp
  tmp="$(mktemp)"
  CHAT_PREFIX=/api/v2/chats
  CHAT_PROBE_STATUS="$(api GET "$tmp" "$CHAT_PREFIX?limit=1" || true)"
  if [ "$CHAT_PROBE_STATUS" = 404 ]; then
    CHAT_PREFIX=/api/experimental/chats
    CHAT_PROBE_STATUS="$(api GET "$tmp" "$CHAT_PREFIX?limit=1" || true)"
  fi
  rm -f "$tmp"
}

# resolve_model <hint> <org> : prints the model config id that the agent's
# resolver would pick, or nothing. resolve-model.jq mirrors
# CoderChatClient.resolveModelConfigId, so doctor runs no checkout code with
# the token. Uses the v2 route, or the legacy route on a 404, as the client does.
resolve_model() {
  local tmp status
  # A UUID hint is returned as is, before any request, as the client does.
  if [[ "$1" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
    printf '%s\n' "$1"
    return 0
  fi
  tmp="$(mktemp)"
  status="$(api GET "$tmp" "/api/v2/organizations/$2/chats/models" || true)"
  if [ "$status" = 404 ]; then status="$(api GET "$tmp" /api/experimental/chats/model-configs || true)"; fi
  if [ "$status" = 200 ]; then jq -r --arg hint "$1" -f "$SKILL/resolve-model.jq" "$tmp"; fi
  rm -f "$tmp"
}

cmd_launch() {
  if command -v mise >/dev/null 2>&1; then
    # Only the two runtime tools: a bare `mise install` also tries global tools.
    mise install node pnpm
    use_mise_toolchain
  fi
  # Dependency lifecycle scripts and the build never get the Coder credentials.
  env -u CODER_SESSION_TOKEN -u CODER_API_TOKEN CI=true pnpm install --frozen-lockfile
  env -u CODER_SESSION_TOKEN -u CODER_API_TOKEN pnpm -r build
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
  pick_chat_prefix
  if [ "$CHAT_PROBE_STATUS" = 200 ]; then check PASS "Coder Agents chat API answers (GET $CHAT_PREFIX)"; else check FAIL "GET $CHAT_PREFIX -> $CHAT_PROBE_STATUS: Coder Agents is not available to this user"; fi
  if [ -n "$org" ]; then
    local hint model_id
    for hint in "${CODER_MODEL:-haiku}" "${CODER_TOOL_MODEL:-sonnet}"; do
      # Same rules as the agent's resolver: provider:model hints, display
      # names, disabled models, and the legacy route behave as in a drive.
      model_id="$(resolve_model "$hint" "$org" || true)"
      if [ -n "$model_id" ]; then
        check PASS "agent model hint \"$hint\" resolves to chat model $model_id"
      else
        check FAIL "agent model hint \"$hint\" resolves to no enabled chat model (set CODER_MODEL / CODER_TOOL_MODEL)"
      fi
    done
  fi
  rm -rf "$tmp"
  if [ "$ok" = 1 ]; then echo "doctor: READY"; else echo "doctor: NOT READY"; return 1; fi
}

# --- drive helpers -----------------------------------------------------------

# run_example <feature-dir> <package> <example> [VAR=value...] : runs one example
# script with extra environment, keeps its output, prints its exit code.
# record-chats.mjs is preloaded: it appends the id of every chat that the
# example creates to created-chats.txt, even when the example dies early.
run_example() {
  local dir="$1" pkg="$2" example="$3" name
  dir="$(absolute "$dir")"
  shift 3
  name="$(basename "$example" .ts)"
  echo "cd packages/$pkg && ${*:+$* }pnpm exec tsx $example" >>"$dir/command.txt"
  local code=0
  # Only the session token reaches checkout code: an ambient CODER_API_TOKEN
  # (which the provider examples prefer) is removed.
  (cd "packages/$pkg" && env -u CODER_API_TOKEN "$@" VERIFY_CHAT_LOG="$dir/created-chats.txt" \
    NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--import=$SKILL/record-chats.mjs" \
    timeout "$DRIVE_TIMEOUT" pnpm exec tsx "$example") \
    >"$dir/$name.stdout.txt" 2>"$dir/$name.stderr.txt" || code=$?
  strip_ansi <"$dir/$name.stdout.txt" >"$dir/$name.clean.txt"
  echo "$code" >"$dir/$name.exit-code.txt"
  echo "$code"
}

# record_chat <feature-dir> <chat-id> : saves the chat and its messages (second view).
record_chat() {
  local dir="$1" id="$2"
  api GET "$dir/chat-$id.json" "$CHAT_PREFIX/$id" >/dev/null
  api GET "$dir/messages-$id.json" "$CHAT_PREFIX/$id/messages?limit=100" >/dev/null
}

# check_created <feature-dir> <expected-count> : reads the second view of every
# chat that the example created, and checks the count and that each is archived.
check_created() {
  local dir="$1" want="$2" id n=0
  sort -u "$dir/created-chats.txt" 2>/dev/null >"$dir/chat-ids.txt" || true
  while read -r id; do
    [ -n "$id" ] || continue
    n=$((n + 1))
    record_chat "$dir" "$id"
  done <"$dir/chat-ids.txt"
  check_that "the example created $want chat(s) (created $n)" [ "$n" = "$want" ]
  local unarchived=""
  while read -r id; do
    [ -n "$id" ] || continue
    is_true "$dir/chat-$id.json" .archived || unarchived="$unarchived $id"
  done <"$dir/chat-ids.txt"
  check_that "the example archived every chat it created${unarchived:+ (left:$unarchived)}" [ -z "$unarchived" ]
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
  jq -j '[.messages | sort_by(.id)[] | select(.role == "assistant") | .content[]? | select(.type == "text") | .text] | join("")' "$1"
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
# usage_matches <example-output> <messages.json> : the printed "Usage :" JSON
# equals the sum over the chat's assistant messages. The input total includes
# cache reads and writes, as the agent's usage mapping does.
usage_matches() {
  node -e '
    const fs = require("node:fs");
    const line = fs.readFileSync(process.argv[1], "utf8").split("\n").find((l) => /^Usage +: /.test(l));
    const got = JSON.parse(line.replace(/^Usage +: /, ""));
    const msgs = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).messages.filter((m) => m.role === "assistant");
    const sum = (key) => msgs.reduce((n, m) => n + (m.usage?.[key] ?? 0), 0);
    const wantInput = sum("input_tokens") + sum("cache_read_tokens") + sum("cache_creation_tokens");
    process.exit(got.outputTokens === sum("output_tokens") && got.inputTokens === wantInput ? 0 : 1);
  ' "$1" "$2"
}
# answer_mentions <example-output> <word> : the Answer block contains the word.
# A digit or "-" next to it is not a match, so "20-sided" does not count as the value 20.
answer_mentions() { [ -n "$2" ] && field_block Answer "$1" | grep -Eq -- "(^|[^0-9-])$2([^0-9-]|$)"; }
is_true() { [ "$(jq -r "$2" "$1" 2>/dev/null)" = true ]; }

# --- features -----------------------------------------------------------------

drive_agent_generate() {
  local dir="$1" code id out
  code="$(run_example "$dir" agent examples/01-generate.ts "CODER_MODEL=${CODER_MODEL:-haiku}")"
  out="$dir/01-generate.clean.txt"
  check_that "example exits 0 (got $code)" [ "$code" = 0 ]
  id="$(sed -n 's/^Chat id *: //p' "$out")"
  # console.log("Answer       :", text) prints the text between that label and
  # "\nFinish reason:". Cut exactly there, so trailing newlines still count.
  node -e '
    const fs = require("node:fs");
    const out = fs.readFileSync(process.argv[1], "utf8");
    const label = "Answer       : ";
    const start = out.indexOf(label);
    const end = out.indexOf("\nFinish reason:", start);
    if (start >= 0 && end >= start) fs.writeFileSync(process.argv[2], out.slice(start + label.length, end));
  ' "$out" "$dir/answer-text.txt"
  check_that "generate() returned text" [ -s "$dir/answer-text.txt" ]
  check_that "finish reason is stop" grep -q '^Finish reason: stop$' "$out"
  check_created "$dir" 1
  if ! grep -qx "$id" "$dir/chat-ids.txt"; then check_that "the printed chat id is a chat the example created" false; return; fi
  committed_text "$dir/messages-$id.json" >"$dir/committed-text.txt"
  check_that "result.text equals the assistant text that chatd committed" cmp -s "$dir/answer-text.txt" "$dir/committed-text.txt"
  check_that "result.usage equals the usage that chatd committed" usage_matches "$out" "$dir/messages-$id.json"
}

drive_agent_stream() {
  local dir="$1" code id out
  code="$(run_example "$dir" agent examples/02-stream.ts "CODER_MODEL=${CODER_MODEL:-haiku}")"
  out="$dir/02-stream.clean.txt"
  check_that "example exits 0 (got $code)" [ "$code" = 0 ]
  # The example writes "\n", then every delta, then "\n\n" before "Steps". Cut
  # exactly that framing, so blank lines inside the reply still count.
  node -e '
    const fs = require("node:fs");
    const out = fs.readFileSync(process.argv[1], "utf8");
    const head = "=== stream() ===\n\n";
    const start = out.indexOf(head);
    const end = out.lastIndexOf("\n\nSteps ");
    if (start >= 0 && end >= start + head.length) fs.writeFileSync(process.argv[2], out.slice(start + head.length, end));
  ' "$out" "$dir/streamed-text.txt"
  check_that "textStream produced text" [ -s "$dir/streamed-text.txt" ]
  check_that "finish reason is stop" grep -q '^Finish reason: stop$' "$out"
  id="$(sed -n 's/^Chat id *: //p' "$out")"
  check_created "$dir" 1
  if ! grep -qx "$id" "$dir/chat-ids.txt"; then check_that "the printed chat id is a chat the example created" false; return; fi
  committed_text "$dir/messages-$id.json" >"$dir/committed-text.txt"
  check_that "streamed text equals the committed text, exactly once" cmp -s "$dir/streamed-text.txt" "$dir/committed-text.txt"
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
  check_created "$dir" 1
  if ! grep -qx "$id" "$dir/chat-ids.txt"; then check_that "the printed chat id is a chat the example created" false; return; fi
  check_that "chatd stored one rollDice tool call" jq -e '[.messages[].content[]? | select(.type == "tool-call" and .tool_name == "rollDice")] | length == 1' "$dir/messages-$id.json"
  check_that "chatd stored one rollDice tool result with value ${value:-?}" jq -e --arg v "${value:--1}" '[.messages[].content[]? | select(.type == "tool-result" and .tool_name == "rollDice") | (.result | if type == "string" then (fromjson? // {}) else . end) | .value == ($v | tonumber)] | length == 1 and all' "$dir/messages-$id.json"
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
  check_created "$dir" 1
  if ! grep -qx "$id" "$dir/chat-ids.txt"; then check_that "the printed chat id is a chat the example created" false; return; fi
  check_that "chatd stored both user turns in that chat" jq -e '[.messages[] | select(.role == "user")] | length == 2' "$dir/messages-$id.json"
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
  check_created "$dir" 0
}

cmd_drive() {
  need_env
  [ $# -gt 0 ] || die "drive needs at least one feature: ${FEATURES[*]}"
  local run feature
  run="$OUT_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-$$"
  mkdir -p "$run"
  pick_chat_prefix
  api GET "$run/buildinfo.json" /api/v2/buildinfo >/dev/null || true
  {
    echo "commit: $(git rev-parse HEAD)$(git diff --quiet HEAD -- packages && echo ' (packages/ clean)' || echo ' + local changes under packages/')"
    echo "node: $(node --version)"
    echo "deployment: $CODER_URL $(jq -r '.version // "unknown"' "$run/buildinfo.json" 2>/dev/null)"
  } >"$run/run.txt"
  echo "run: $run"
  for feature in "$@"; do
    case " ${FEATURES[*]} " in *" $feature "*) ;; *) die "unknown feature $feature (known: ${FEATURES[*]})" ;; esac
    local dir="$run/$feature"
    mkdir -p "$dir"
    CHECKS="$dir/checks.txt"
    echo "== $feature"
    "drive_${feature//-/_}" "$dir"
  done
  echo "evidence: $run"
  if [ "$FAILED" = 0 ]; then echo "drive: PASS"; else echo "drive: FAIL"; return 1; fi
}

cmd_cleanup() {
  need_env
  local run id status tmp failed=0
  run="$(absolute "${1:-}")"
  [ -n "${1:-}" ] && [ -d "$run" ] || die "cleanup needs the run directory that drive printed"
  pick_chat_prefix
  tmp="$(mktemp)"
  for id in $(cat "$run"/*/created-chats.txt 2>/dev/null | sort -u); do
    status="$(api GET "$tmp" "$CHAT_PREFIX/$id")"
    if [ "$status" = 200 ] && [ "$(jq -r .archived "$tmp")" = true ]; then
      echo "already archived: $id" | tee -a "$run/cleanup.txt"
      continue
    fi
    status="$(api PATCH "$tmp" "$CHAT_PREFIX/$id" '{"archived":true}')"
    case "$status" in
      2??) echo "archived $id (HTTP $status)" | tee -a "$run/cleanup.txt" ;;
      409)
        echo "FAILED $id: HTTP 409, the chat is busy or waits in requires_action (see SKILL.md, Gotchas)" | tee -a "$run/cleanup.txt"
        failed=1
        ;;
      *)
        echo "FAILED $id: HTTP $status" | tee -a "$run/cleanup.txt"
        failed=1
        ;;
    esac
  done
  rm -f "$tmp"
  if [ "$failed" = 1 ]; then
    echo "cleanup: FAILED for some chats; evidence kept in $run"
    return 1
  fi
  echo "cleanup: done; evidence kept in $run"
}

case "${1:-}" in
  launch) cmd_launch ;;
  doctor) cmd_doctor ;;
  features) printf '%s\n' "${FEATURES[@]}" ;;
  drive) shift; cmd_drive "$@" ;;
  cleanup) shift; cmd_cleanup "$@" ;;
  *) sed -n '2,16p' "$0"; exit 2 ;;
esac
