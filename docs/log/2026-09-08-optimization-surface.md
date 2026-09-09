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
  per-lane saved bars, and the Advisor. Opening the tab probes `/health` and
  resolves `headroom` on the login-shell PATH; it never starts the proxy and
  never installs anything.
- **The Advisor** (`electron/optimization/advisor.ts`): four pure rules —
  cache churn (cacheWrite > 50% of a lane's ≥200k of cached-context traffic),
  headroom coverage (off / not installed / proxy down, graded), MCP schema
  weight (≥3 servers),
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

## Changed on the rebase (2026-09-08, after the rename)

- `PIDEX_HEADROOM_URL` → **`PHOSPHOR_HEADROOM_URL`**, the variable the
  extension on main actually reads, plus `window.pidex` → `window.phosphor`
  in the tab. Both were silent breakages: with the old names the feature
  compiles, ships and saves nothing.
- The supervisor's port is injectable (`SupervisorDeps.port`, default 8787)
  so `chain.test.ts` can spawn a real proxy without touching the machine-wide
  port.
- A detection MISS is cached for 5 s. `resolveBinary` runs a login shell, and
  the not-installed case — the common one — was paying one per `status()`
  call, which the tab makes on mount and after every button.
- `Toggle` grew a `disabled` prop. The text-compression row was rendering a
  switch that silently refused every click.

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

Three more were added when this branch was rebased onto the Phosphor rename
(2026-09-08), because every test above injects the boundary it tests, and the
rename proved that leaves the seams uncovered — the supervisor shipped
`PIDEX_HEADROOM_URL` while the extension read `PHOSPHOR_HEADROOM_URL`, and
nothing failed:

- **`headroom/chain.test.ts`** runs the whole chain against a real process and
  a real socket: the supervisor spawns `__fixtures__/fake-headroom.cjs` (which
  exits 2 if the argv or privacy env drift), the extension is built from
  `sessionEnv()` rather than a constant, the compressed result is checked for
  every record it started with, and the receipt is folded back into
  `headroomSavedTokens`. Also covers the two refusals: an unretrievable
  omission marker, and a proxy that dies mid-session. Verified non-vacuous by
  mutation — reverting the env var name fails it, and dropping
  `--no-subscription-tracking` fails three of its cases.
- **`session-fold.test.ts` → "a real captured session"** folds a session file
  captured from a live run (pi 0.85.1, Headroom 0.37.0), kept at
  `electron/pi/__fixtures__/headroom-live-session.jsonl`. The receipt is a
  wire contract with pi that nothing in this repo compiles against, so the
  guard is a real file: 120 JSON records came back as a typed header plus 120
  CSV rows, the receipt says 7,300 → 5,369 tokens, and the model answered the
  count and the last id exactly from the compressed text.
- **`e2e/smoke.spec.ts` → "the optimization tab reports headroom state"**
  opens Settings → Optimization in a real Electron main and asserts both new
  channels answered, the shipped-off state, and the inert text-compression
  switch.

## Measured: what compression actually returns

From the proxy's own ledger on the development machine (`~/.headroom/`,
2026-09-07 → 2026-09-08, Headroom 0.37.0), covering both the research runs and
the live end-to-end sessions:

| Evidence                                    | Number                                                   |
| ------------------------------------------- | -------------------------------------------------------- |
| Lifetime ledger (`proxy_savings.json`)      | 70 requests, 1,269,962 tokens saved, $3.90               |
| 35 `/v1/compress` events (`savings_events`) | 594,834 → 325,942 tokens, **45.2% aggregate**            |
| Backends covered by those events            | Anthropic direct, Bedrock (`us.anthropic.*`), OpenRouter |
| Live sessions with a persisted receipt      | 5, on 3 providers (Bedrock, OpenRouter, pi-claude-cli)   |

The per-event spread is the honest picture, and it is why the JSON gate is
load-bearing:

- **24–45%** on uniform JSON records — the case the feature is for. Scaffolding
  (repeated keys, quotes, braces) is what goes.
- **0.2–0.7%** on heterogeneous or prose-heavy JSON — `router:noop`, and the
  extension discards a result that did not get smaller.
- **97.5%** twice, on plain-text `grep` output. Those are the _lossy_
  transforms, and the shipped configuration refuses them: the JSON gate stops
  them reaching the model, so this saving is deliberately not banked. It is
  also the size of the prize behind the CCR partnership ask.

Fidelity, not just ratio: the captured session shows 120 of 120 records
surviving the restructure, and the model answering `120` / `ISS-0119` exactly
from the compressed text.

## Correction, 2026-09-09: the cache-churn rule was measuring the wrong ratio

Shipped as `cacheWrite ÷ totalTokens`. Wrong units: pi's per-message
`usage.totalTokens` is the provider's own number, and on pi-claude-cli it
tracks the request's context size and EXCLUDES `cacheRead`, so a sum of it
across turns is not a quantity a cumulative `cacheWrite` can be divided by.

Caught in the wild the day it shipped. A real lane with 528k written against
13.4M read — 96% cache REUSE, which is as healthy as it gets — was reported
SERIOUS as "96% of its tokens on cache writes" against a 549k totalTokens sum.

Now `cacheWrite ÷ (cacheWrite + cacheRead)`, with the 200k floor moved onto the
same denominator: the share of a lane's cached context that had to be rebuilt
rather than reused. The same lane reads 3.8% and stays quiet. The detail text
also stopped implying the only cause is an old pi-claude-cli; a long gap
between turns expires the provider's prompt cache and looks identical.
Regression test uses the real numbers.
