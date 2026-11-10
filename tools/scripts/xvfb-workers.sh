#!/usr/bin/env bash
# Run a command with N private Xvfb displays, one per Playwright worker:
#
#   tools/scripts/xvfb-workers.sh 4 npx playwright test --workers=4 ...
#
# A display has one focused window, and the app hides hover hints in a window
# that lost focus (Tooltip.tsx), so parallel Electron windows on one shared
# display steal focus from each other's tests. apps/desktop/playwright.config.ts
# points each worker at its own display through PHOSPHOR_E2E_DISPLAYS.
# Xvfb picks free display numbers (-displayfd): several runners share a machine.
set -euo pipefail
count="$1"
shift
dir="$(mktemp -d)"
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  rm -rf "$dir"
}
trap cleanup EXIT
displays=()
for ((n = 0; n < count; n++)); do
  Xvfb -displayfd 3 -screen 0 1600x1200x24 -nolisten tcp 3>"$dir/$n" >/dev/null 2>&1 &
  pids+=("$!")
done
for ((n = 0; n < count; n++)); do
  for _ in $(seq 100); do [[ -s "$dir/$n" ]] && break; sleep 0.1; done
  [[ -s "$dir/$n" ]] || { echo "Xvfb $n did not start" >&2; exit 1; }
  displays+=(":$(tr -d '[:space:]' <"$dir/$n")")
done
PHOSPHOR_E2E_DISPLAYS="$(IFS=,; echo "${displays[*]}")"
export PHOSPHOR_E2E_DISPLAYS
# The runner process (and its warm-up) uses the first one.
export DISPLAY="${displays[0]}"
echo "Xvfb displays: $PHOSPHOR_E2E_DISPLAYS" >&2
"$@"
