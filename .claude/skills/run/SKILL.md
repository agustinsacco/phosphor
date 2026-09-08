---
name: run
description: Launch Phosphor to see a change working — Electron dev mode with a real pi, the browser-only mock harness, or a stubbed Electron instance when no pi/API key is available. Use when asked to run, start, demo, or visually verify the app.
---

# Running Phosphor

Pick the lightest mode that can show the change:

## 1. Renderer-only (no Electron, no pi) — UI look & feel

```bash
npx vite dev
```

Open the printed localhost URL in a browser. `src/main.tsx` detects the
missing `window.phosphor` and installs `src/dev/mockPhosphor.ts`: canned sessions,
a scripted streaming reply, mock file tree/terminal. Good for layout, chat
rendering, sidebar, theming. Useless for anything touching real IPC, pi, git,
or PTYs. If your change added an IPC channel that a rendered screen calls,
add a mock case or the screen will get `undefined`.

Debug hooks in the browser console: `__chatStore`, `__sessionsStore`,
`__extUiStore` (zustand stores).

## 2. Full dev app (Electron + HMR) — the real thing

```bash
npm run dev
```

Requires `pi` on PATH (`npm i -g @earendil-works/pi-coding-agent`, Node ≥
22.19) and a signed-in provider (or a local endpoint in `~/.pi/agent/`).
Without pi the app boots to the "pi missing" screen — still fine for testing
the shell, settings, terminal, and that screen itself.

## 3. Stubbed Electron (no pi, no API key) — deterministic full app

Build once, then launch against the e2e stub:

```bash
npm run build
PHOSPHOR_PI_STUB="$PWD/e2e/fixtures/pi-stub.cjs" \
PHOSPHOR_E2E_WORKSPACE="$(mktemp -d)" \
PHOSPHOR_TEST_USER_DATA="$(mktemp -d)" \
PI_CODING_AGENT_DIR="$(mktemp -d)" \
npx electron .
```

The stub speaks the full RPC protocol with a scripted session (streamed
markdown, an edit tool call with a diff, an artifact). This is exactly what
the e2e suite drives. The env hooks only work unpackaged (`!app.isPackaged`)
— that gate is a security boundary, do not remove it.

## Verifying without eyes

Prefer the Playwright suite for assertions (`/e2e` skill). For a one-off
check, `npx playwright test e2e/smoke.spec.ts -g "<test name>"` after a build
is faster than hand-driving the app.
