#!/usr/bin/env bash
# Run the Playwright-Electron suite without windows landing on your screen.
#
# There are two ways to be invisible and they are NOT equivalent in speed:
#
#   xvfb-run   The windows are ordinary mapped windows; they just render into a
#              virtual display instead of yours. Full speed. This is what CI
#              already does (.github/workflows/ci.yml).
#
#   unmapped   No display server required: the app leaves its windows unmapped
#              (electron/window-chrome.ts:hideWindowsForE2E). Chromium
#              deprioritizes rendering for a window that was never shown, so
#              the suite is correct but roughly 2-3x slower. This is also the
#              only option on macOS, which has no xvfb.
#
# So: use xvfb when it is installed, and inside it let the windows map normally.
# Install once on Debian/Ubuntu with:  sudo apt install xvfb
#
# PHOSPHOR_E2E_SHOW=1 runs the suite on your real display, for when you actually
# want to watch it.
set -uo pipefail
cd "$(dirname "$0")/.."

if [[ "${PHOSPHOR_E2E_SHOW:-}" == "1" ]]; then
  exec npx playwright test "$@"
fi

if command -v xvfb-run >/dev/null 2>&1; then
  # PHOSPHOR_E2E_SHOW=1 inside the virtual display on purpose: nothing reaches a
  # human screen there, so mapping the windows costs nothing and avoids the
  # unmapped-rendering penalty described above.
  exec env PHOSPHOR_E2E_SHOW=1 xvfb-run --auto-servernum \
    --server-args='-screen 0 1600x1200x24' npx playwright test "$@"
fi

exec npx playwright test "$@"
