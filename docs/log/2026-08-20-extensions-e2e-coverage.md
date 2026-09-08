# 2026-08-20 — E2E coverage for the extensions surface (WS2 completion)

The pi stub (`e2e/fixtures/pi-stub.cjs`) now speaks pi's package-manager
CLI as well as RPC: `install`/`remove` edit the sandboxed settings.json and
create/delete the npm install-dir layout (so `packages:list` sees real
state), `update` and print mode (`-p`) answer deterministically. CLI mode
exits before any RPC/session-file setup — an install must not create a
stub session.

To route package jobs through it, the job runner gained the same override
mechanism as the session spawner: `packages-handlers` passes
`PHOSPHOR_PI_STUB` (gated `!app.isPackaged`, same env-var-code-execution
rationale) and `packages.ts` runs the stub via Electron-as-Node. A second
gated hook, `PHOSPHOR_CLAUDE_BIN`, pins the Claude binary for
`claudeStatus`/`detectBinaries` — the first version of the chain test used
PATH-prepending and was promptly shadowed by the developer's real
`~/.local/bin/claude`, which is exactly the machine-dependence the
override kills.

New tests (all green on a fresh build):

- **install/remove round-trip** — Extensions tab spec input → streamed
  `pi install` output → row appears installed (stub version) → Remove →
  row gone.
- **web-access keys** — Web access tab Set key → Enter →
  `web-search.json` in the sandboxed agent dir contains the value
  (polled), row flips to "configured".
- **claude provider chain** — fake claude via `PHOSPHOR_CLAUDE_BIN`
  (version + auth JSON), health card asserts binary and account rows,
  Test provider streams `Phosphor-provider-ok` through the stubbed pi print
  mode and the tab confirms the round-trip.

Note from the shadowing incident: a real claude 2.1.237 login on the dev
box was picked up by the unoverridden probe — good evidence the health
card works against reality, bad for determinism; hence the override.
