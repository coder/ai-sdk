#!/usr/bin/env bash
# Proves that the exactly-once check can fail. For each mutants/*.patch:
# apply it to the real code, run check.sh, and require that a scenario which
# passes on clean code now fails with the property on the patch's `Expect:`
# line. Every patch is reverted, also when the script is interrupted.
#
# Usage, from anywhere in the repository:
#   .agents/skills/verify-agent-stream-exactly-once/mutants.sh
#
# Refuses to run when a file that a patch touches has local changes.
set -euo pipefail

SKILL="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(git -C "$SKILL" rev-parse --show-toplevel)"
cd "$ROOT"
LOGS="$(mktemp -d)"

applied=""
revert() {
  if [ -n "$applied" ]; then
    git apply -R "$applied"
    applied=""
  fi
}
trap revert EXIT INT TERM

for patch in "$SKILL"/mutants/*.patch; do
  for file in $(git apply --numstat "$patch" | cut -f3); do
    if ! git diff --quiet -- "$file"; then
      echo "mutants.sh: $file has local changes; commit or stash them first" >&2
      exit 2
    fi
  done
done

echo "baseline (clean code):"
FORMAL_OUT="$LOGS/baseline.log" "$SKILL/check.sh" >/dev/null || {
  echo "mutants.sh: the check fails on clean code; fix that first ($LOGS/baseline.log)" >&2
  exit 2
}
mapfile -t passing < <(sed -n 's/^RESULT scenario="\([^"]*\)" status=pass .*/\1/p' "$LOGS/baseline.log")
printf '  passing scenario: %s\n' "${passing[@]}"

missed=0
for patch in "$SKILL"/mutants/*.patch; do
  name="$(basename "$patch" .patch)"
  expect="$(sed -n 's/^Expect: //p' "$patch" | head -1)"
  git apply "$patch"
  applied="$patch"
  FORMAL_OUT="$LOGS/$name.log" "$SKILL/check.sh" >/dev/null 2>&1 || true
  revert
  caught=""
  for scenario in "${passing[@]}"; do
    line="$(grep -F "RESULT scenario=\"$scenario\" " "$LOGS/$name.log" || true)"
    case "$line" in
      *status=fail*violated=*"$expect"*) caught="$scenario" ;;
    esac
  done
  if [ -n "$caught" ]; then
    echo "CAUGHT $name: $expect broke in \"$caught\""
  else
    echo "MISSED $name: no passing scenario broke $expect (log: $LOGS/$name.log)"
    missed=1
  fi
done

git diff --quiet -- packages/agent/src || {
  echo "mutants.sh: packages/agent/src is not clean after the run" >&2
  exit 3
}
echo "logs: $LOGS"
exit "$missed"
