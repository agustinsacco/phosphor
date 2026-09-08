#!/usr/bin/env bash
# Full validation, quiet by default: prints a short PASS/FAIL summary and
# leaves full output in a log file. The dot reporter keeps Playwright's
# chatter out of the terminal; the Electron windows stay off your screen
# because scripts/e2e.sh runs them under xvfb (or unmapped) — see that file.
set -uo pipefail
cd "$(dirname "$0")/.."

LOG="${VALIDATE_LOG:-/tmp/phosphor-validate-$$.log}"
: > "$LOG"
FAILED=()

step() {
  local name="$1"; shift
  printf '%-12s' "$name" >&2
  if "$@" >>"$LOG" 2>&1; then
    printf 'PASS\n' >&2
  else
    printf 'FAIL\n' >&2
    FAILED+=("$name")
  fi
}

step typecheck npm run typecheck
step lint      npm run lint
step format    npx prettier --check .
step unit      npm test
if [[ "${SKIP_E2E:-}" != "1" ]]; then
  step e2e npm run test:e2e -- --reporter=dot
fi

echo >&2
if ((${#FAILED[@]})); then
  echo "FAILED: ${FAILED[*]}" >&2
  echo "log: $LOG" >&2
  exit 1
fi
echo "all green — log: $LOG" >&2
