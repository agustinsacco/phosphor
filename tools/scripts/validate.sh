#!/usr/bin/env bash
# Full validation, quiet by default: prints a short PASS/FAIL summary and
# leaves full output in a log file. The dot reporter keeps Playwright's
# chatter out of the terminal; the Electron windows stay off your screen
# because tools/scripts/e2e.sh runs them under xvfb (or unmapped) — see that file.
#
# --pr (npm run check:pr) is the pre-PR check: CI's checks and unit tests, plus
# only the Desktop and Web e2e spec files this branch changes against
# origin/main (committed, staged, unstaged or new). CI runs the rest.
set -uo pipefail
cd "$(dirname "$0")/../.."

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

if [[ "${1:-}" == "--pr" ]]; then
  step typecheck npm run typecheck
  step lint      npm run lint
  step format    npx prettier --check .
  step size      node tools/scripts/size-budget.mjs check
  step unit      npm test
  BASE="${VALIDATE_BASE:-$(git merge-base origin/main HEAD 2>/dev/null || echo HEAD)}"
  # Changed spec files that still exist, by name: Playwright matches it in the path.
  specs() {
    { git diff --name-only "$BASE" -- "$1"; git ls-files --others --exclude-standard -- "$1"; } |
      sort -u | while read -r file; do [[ -f "$file" ]] && basename "$file"; done
  }
  DESKTOP_SPECS=$(specs 'apps/desktop/e2e/*.spec.ts')
  WEB_SPECS=$(specs 'apps/web/e2e/*.spec.ts')
  if [[ "${SKIP_E2E:-}" != "1" ]]; then
    # Word splitting is intended: one argument per spec file.
    # shellcheck disable=SC2086
    [[ -n "$DESKTOP_SPECS" ]] && step e2e npm run test:e2e -- --reporter=dot $DESKTOP_SPECS
    # shellcheck disable=SC2086
    [[ -n "$WEB_SPECS" ]] && step web-e2e npm run test:e2e:web -- --reporter=dot $WEB_SPECS
  fi
else
  step typecheck npm run typecheck
  step lint      npm run lint
  step format    npx prettier --check .
  step unit      npm test
  # Always compile, including SKIP_E2E=1. The E2E command retains its own build.
  step build     npm run build
  step host-build npm run build:host
  step control-build npm run build:control
  step web-build npm run web:build
  # Requires `npm run db:start`; CI runs this suite in its own isolated job.
  if [[ "${CONTROL_DB:-}" == "1" ]]; then
    step control-db npm run test:control-db
    step auth-stack npm run test:auth-stack
  fi
  if [[ "${SKIP_E2E:-}" != "1" ]]; then
    step e2e npm run test:e2e -- --reporter=dot
    step web-e2e npm run test:e2e:web -- --reporter=dot
  fi
fi

echo >&2
if ((${#FAILED[@]})); then
  echo "FAILED: ${FAILED[*]}" >&2
  echo "log: $LOG" >&2
  exit 1
fi
echo "all green — log: $LOG" >&2
