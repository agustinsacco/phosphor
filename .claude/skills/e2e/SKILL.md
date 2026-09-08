---
name: e2e
description: Run or extend the Playwright-Electron e2e suite (deterministic pi stub, no API key). Use when verifying IPC/session/UI flows end-to-end, debugging a failing smoke test, or adding e2e coverage for a new feature.
---

# Phosphor e2e suite

```bash
npm run test:e2e                      # full: build + all specs
npm run build                         # rebuild after any main/renderer change
npx playwright test                   # specs only (uses the existing build!)
npx playwright test -g "sidebar"      # one test by title substring
npx playwright test --headed          # watch it run
```

**Playwright runs `out/` — a stale build is the #1 source of confusing
failures.** If a spec fails right after you changed code, rebuild first.

## How it works

- `e2e/smoke.spec.ts` — 8 serial specs, 1 worker; each test launches its own
  Electron instance via `_electron.launch`.
- `e2e/fixtures/pi-stub.cjs` — a ~350-line deterministic RPC "pi": scripted
  streamed reply, an edit tool call with a diff, an artifact tool call.
  No network, no API key.
- Env contract (all gated on `!app.isPackaged`):
  - `PHOSPHOR_PI_STUB` — path to the stub; main spawns it instead of real pi
  - `PHOSPHOR_E2E_WORKSPACE` — skips the native (undriveable) folder picker
  - `PHOSPHOR_TEST_USER_DATA` — isolates electron-store prefs per test
  - `PI_CODING_AGENT_DIR` — pins pi's session dir to a scratch dir
- The stub writes a real session JSONL into the **mangled session dir** for
  the workspace (pi's `--<cwd with / → ->--` layout) — that's what makes
  sessions discoverable by the sidebar scanner. The mangling is duplicated
  from `electron/pi/pi-paths.ts` in the stub; if a sidebar/scan test fails
  mysteriously, check the two haven't drifted.

## Adding a test

- Follow the existing pattern: the `launch()` / `shutdown()` helpers, `data-testid`
  selectors (`session-row`, `workspace-group`, `workspace-switcher`,
  `session-workspace-badge`) or `getByRole` with aria-labels.
- Composer buttons are icon buttons with aria-labels: "Send message",
  "Start session", "Stop", "Attach images".
- New prefs/IPC used at boot need nothing special — the real handlers run;
  only the *browser* mock (`src/dev/mockPhosphor.ts`) needs explicit cases.
- Keep tests serial-safe: fresh `mktemp` dirs per launch, no shared state.

CI runs this matrix on ubuntu (xvfb) and macOS with `electron-rebuild` for
node-pty.
