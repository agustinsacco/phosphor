# The Optimization surface

**Status: SHIPPED 2026-09-08** (2a receipts+fold, 2b tab, 3 supervisor+advisor
landed together — see
[docs/log/2026-09-08-optimization-surface.md](../log/2026-09-08-optimization-surface.md);
the Deck chip still waits for the Deck). Companion to
[headroom-compression.md](headroom-compression.md) — the UI/UX half. Drafted
2026-09-07; mock numbers are the measured ones from that spec.

Deviations from the plan below, as built: the receipts persistence probe
became a fold test (`session-fold.test.ts`, receipts verified against a real
session file first); the lane-savings surface on the home screen is the
Ledger's Saved tile + per-lane column, not a separate view; the Advisor
shipped four rules (cache churn, headroom coverage, MCP schema weight,
long-session drag) — provider-version gates, model mix and plan pacing wait
for real-fleet tuning.

## Where it lives

A new Settings tab named **Optimization** — not under Agent. AgentTab is an
editor for pi's own `settings.json`; a dashboard does not belong in it. The
phase-2 "HeadroomTab" from the integration plan grows into this tab instead
(same IPC, same files, broader name).

Three altitudes, two of which already have a surface:

| Altitude | Surface                        | Answers                                                    |
| -------- | ------------------------------ | ---------------------------------------------------------- |
| Machine  | Settings → Optimization (new)  | installed / running / routed / fleet savings / what to fix |
| Session  | Context meter (exists)         | live savings + what is eating this window                  |
| Fleet    | The Deck (vision doc, unbuilt) | later: a savings chip per flight strip, same IPC           |

Cheap by construction: `electron/pi/session-fold.ts` already folds
totalTokens / input / output / cacheRead / cacheWrite / cost per session from
disk, and the scanner aggregates per workspace. Savings-per-lane is one more
folded field plus one read-only IPC channel. Cross-session views stay
projections of the disk scan — no manager returns.

## The tab

Four zones: headline tiles (saved 7d, compression rate, Headroom state,
advisor count) → saved-by-lane bars (single series, direct-labeled, row click
opens the session) → the Advisor → the Headroom manager (install / proxy /
L1 / L2 cards). Opening Settings never spawns a process; everything renders
from cached scan data, pi-health style.

The session altitude is one context-meter section (`Optimization · Headroom`:
saved this session, last result, skipped-lossy, overhead) fed by the
structured `Phosphor-headroom` status key — hidden when never pushed, exactly
like plan limits on non-Claude sessions.

## The Advisor

A rules engine over data Phosphor already has — never a model call, never an
actor. Each check is a pure function with one action button that opens the
surface owning the change (scope guard: the 2026-09-03 orchestration removal
stays removed).

| Check                  | Signal (source)                                                             | Emits                                                                |
| ---------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Cache health           | cacheWrite ÷ totalTokens spikes (fold)                                      | full-context re-bill caught live; points at provider version/restart |
| Provider version gates | installed pi-claude-cli vs known minimums (0.4.16 / 0.5.1 / 0.6.1 / 0.7.0)  | "update the package" with the cost of not doing it                   |
| MCP schema weight      | connected servers (mcp.json + mcp-status) vs servers actually called (fold) | "N connected, M used — ~13k tok/request" (measured 30→13 tools)      |
| Long-session drag      | totalTokens vs window; context-breakdown composition                        | "fork from the bookmark instead" — surfaces existing primitives      |
| Model mix              | folded cost × model id                                                      | advisory model suggestion; never auto-switches                       |
| Plan pacing            | rate-limit % + reset (Claude provider status key) across accounts           | burn-rate projection; suggests account routing that already exists   |
| Headroom coverage      | skipped-vs-compressed counters from L1                                      | the lossy-exclusion ceiling — evidence for the CCR partnership ask   |

## Plumbing

1. **L1 writes a receipt into the result it patches**: `details.headroom =
{ saved, before, ms }`. pi persists the message, so the receipt lands in
   the session JSONL beside the compressed content — survives resume/fork,
   both harnesses, zero new files.
2. **`session-fold.ts` folds it**: `headroomSavedTokens` in `FoldState` /
   `SessionMeta`, summed like `cacheReadTokens`.
3. **One read-only IPC channel** `optimization:stats(workspace?)`: folded
   aggregates + advisor findings, computed in main. Mock case in
   `mockPhosphor.ts`.
4. **Proxy metrics as cross-check**: lifetime totals for the manager card,
   and a drift signal when non-Phosphor sessions share the adopted proxy.

**Verify before 2a is committed:** pi persists a hook's `details` patch
verbatim (content-patch persistence is validated; details round-trip is a
10-minute probe with the L1 rig). Fallback: sidecar under Phosphor userData —
never beside pi's session files.

## Delivery

Reshapes integration-plan phases 2–3 into three lane-sized PRs:

- **2a — receipts + fold**: L1 receipts, fold + scanner field, persistence
  probe as a test.
- **2b — the tab, read-only**: OptimizationTab, `optimization:stats`,
  context-meter section, mock harness case.
- **3 — lifecycle + advisor**: proxy supervisor + install job (as planned),
  advisor rules each behind a unit test.

Deck chip waits for the Deck; it reads the same channel when it exists.

## Open questions

- Name: Optimization (recommended) vs Efficiency vs Tokens — pick before 2b.
- Dollars only for API/Bedrock-billed sessions; tokens elsewhere.
- Advisor thresholds ship conservative and tune from real fleets.
