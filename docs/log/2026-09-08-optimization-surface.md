# The Optimization surface ships whole (phases 2–3)

One PR lands everything after phase 1 of the Headroom plan
([spec](../specs/headroom-compression.md),
[UI spec](../specs/optimization-surface.md)): the savings fold, the
Settings → Optimization tab, the home-screen Ledger columns, the Advisor, and
the proxy supervisor that makes compression a toggle instead of an env var.

## What exists now

- **Receipts fold from disk.** `session-fold.ts` sums the
  `details.headroom.savedTokens` receipts the phase-1 extension writes into
  pi's session files (`role: toolResult` messages) into
  `SessionMeta.headroomSavedTokens`; `workspaceStats` aggregates it as
  `savedTokens`. No sidecar file — the receipt shape was verified against a
  real live-run session file before the fold was written.
- **Settings → Optimization** (between Workspaces and Advanced): Headroom
  manager (detect install, adopt/start/stop the proxy, guided `uv`/`pipx`
  install streamed over the package-job channels), the compression toggle,
  per-lane saved bars, and the Advisor. Opening the tab probes `/health` but
  never spawns anything.
- **The Advisor** (`electron/optimization/advisor.ts`): four pure rules —
  cache churn (cacheWrite > 50% of a ≥200k-token session), headroom coverage
  (off / not installed / proxy down, graded), MCP schema weight (≥3 servers),
  long-session drag (≥5M tokens → fork from a bookmark). Advice only, each
  with a pointer at the settings tab that owns the fix; nothing here acts.
- **Ledger** (home screen): a Saved tile and a per-lane saved column, both
  rendered only when the workspace has ever saved anything.
- **The supervisor** (`electron/headroom/proxy.ts`), where the care went:
  - ONE proxy per machine, loopback only (`--host 127.0.0.1`, plus
    `HEADROOM_HOST` pinned so a shell-profile value cannot widen the bind).
    A healthy proxy already on 8787 is ADOPTED, never duplicated; Phosphor only
    ever kills a proxy it spawned.
  - An owned proxy never outlives Phosphor (`will-quit` kill; child not
    detached).
  - No restart loops: two exits within 10 s of spawn stop auto-start with an
    error until the user acts (enable/start resets the budget).
  - Privacy pinned per spawn: `HEADROOM_BEACON=off`, `DO_NOT_TRACK=1`,
    `HEADROOM_UPDATE_CHECK=off`, `--no-subscription-tracking` (required for
    multi-account Claude), and `HEADROOM_COMPRESSORS=smart_crusher,tabular`
    so a Phosphor-managed proxy can only run the lossless families.
  - Sessions get `PHOSPHOR_HEADROOM_URL` only while the proxy is believed
    healthy; a stale belief costs one failed in-session health probe because
    the extension fails open (phase-1 design).
- **IPC**: `headroom:status/setEnabled/start/stop/install` +
  `optimization:stats` in `electron/ipc/optimization-handlers.ts`; the
  install job reuses the `packages:output/exit:<jobId>` stream. Mock cases in
  `mockPhosphor.ts` make the whole tab work in the browser harness.

## Deliberately not in this PR

- Layer 2 (proxy routing of model traffic) stays deferred — decision
  2026-09-07, recorded in the spec.
- The "Compress search & log output" toggle renders disabled: text
  compression is reversible only through a retrieve tool that does not exist
  yet.
- The Deck savings chip waits for the Deck.

## Tests

`session-fold.test.ts` (receipt fold, malformed receipts, incremental-resume
equality), `headroom/proxy.test.ts` (12 lifecycle-safety cases: spawn
contract, adopt-never-duplicate, single-flight, crash budget, owned-only
kills, quit kill, sessionEnv), `optimization/advisor.test.ts` (rule
thresholds, grading, ordering).
