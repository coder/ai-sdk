#!/usr/bin/env bash
# Runs the bounded exhaustive exactly-once check of the @coder/ai-sdk-agent
# stream path (packages/agent/test/formal/stream-exactly-once.check.ts).
#
# Usage, from anywhere in the repository:
#   .agents/skills/verify-agent-stream-exactly-once/check.sh            # every scenario
#   .agents/skills/verify-agent-stream-exactly-once/check.sh "one step" # scenarios whose name matches
#
# Exit 0: every scenario passed, and each known finding still reproduces as
# recorded. The full log is written to $FORMAL_OUT (default under $TMPDIR).
set -euo pipefail

ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$ROOT"

# Use the toolchain pinned in mise.toml: the ambient PATH can carry an older
# Node and pnpm.
if command -v mise >/dev/null 2>&1; then
  if node_dir="$(mise where node 2>/dev/null)" && pnpm_bin="$(mise which pnpm 2>/dev/null)"; then
    PATH="$node_dir/bin:$(dirname "$pnpm_bin"):$PATH"
  else
    echo "check.sh: mise has not installed the pinned Node and pnpm; run: mise install node pnpm" >&2
    exit 2
  fi
fi
if [ ! -d packages/agent/node_modules ]; then
  echo "check.sh: packages/agent/node_modules is missing; run: CI=true pnpm install --frozen-lockfile" >&2
  exit 2
fi

OUT="${FORMAL_OUT:-${TMPDIR:-/tmp}/agent-stream-exactly-once.log}"
echo "node $(node --version), pnpm $(pnpm --version), commit $(git rev-parse --short HEAD)$(git diff --quiet HEAD -- packages/agent/src || echo ' + local changes in packages/agent/src')"

args=(exec vitest run --config test/formal/vitest.config.ts --no-color)
if [ $# -gt 0 ]; then args+=(-t "$1"); fi

set +e
(cd packages/agent && pnpm "${args[@]}") >"$OUT" 2>&1
status=$?
set -e

# The report: scenario summaries, counterexamples, and one RESULT line each.
grep -E '^(scenario:|  runs:|  VIOLATION|    [0-9]+\. |    => |  KNOWN FINDING|RESULT )' "$OUT" || true
if [ "$status" -ne 0 ]; then
  echo "--- check FAILED (exit $status); vitest summary:"
  grep -E 'FAIL|AssertionError|Error:|Tests  ' "$OUT" | head -20 || true
fi
echo "full log: $OUT"
exit "$status"
