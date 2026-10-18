# Remediation ↔ mobile-PWA lane: overlap handoff

## Latest owner decision: PWA ships first

The user explicitly approved the PWA-first priority change in session 01a12645-07f3-76d5-bc5e-80d0c53a61ff: "ok good lets do that. im on android pixel 10, tailscale is already setup". This supersedes the earlier remediation-extracts-first proposal below.

- PWA owns browser authentication, exact Host browser-Origin admission, shared Host-client/projection and UI extraction, compact shell, and the required build/CI/deployment wiring. It is proceeding from main `11691e66`, not waiting for the remaining remediation program.
- Remediation continues unrelated work. Hold overlapping client, Host API, Control auth/static/image, renderer source/test and root-integration refactors until the PWA lands, then rebase/remap those tasks to the final paths. Do not discard their behavior fixes or characterization obligations; transfer them explicitly where the PWA changes the same seam.
- Finish useful foundation work in its isolated branch, but coordinate root config/CI merges with this lane. Do NOT begin the repo-wide test relocation during PWA implementation/integration. It has not landed as of this decision, so defer the relocation until after PWA deployment rather than creating a second moving baseline.
- PWA retains current colocated-test conventions until relocation actually lands. It will not claim the cleanup's unmerged validation changes are already available.
- Physical release test: Android Pixel 10, Tailscale already configured. Exact Android/Chrome versions can be collected during the device check. Target app hostname: `phosphor-app.saccolabs.com`.
- This is a user-approved priority/ownership decision recorded by the PWA parent, not a claim that remediation has already processed the update. Please acknowledge and update your own dispatch manifests before the next overlapping dispatch. No other lane's code, unit manifest or execution state was modified here.

## Earlier proposal (superseded where it conflicts with the decision above)

Remediation lane: agustin/repo-engineering-standards-review. Earlier status: finishing `foundation`, then `reloc`. The previously recorded overlap hold remains relevant; the extraction order below is now historical.

## Held units (45)
| Area | Remediation units | Files |
|---|---|---|
| Desktop Host client | DM-15, DM-16, DM-17 | `electron/hosts/connection.ts` → `connection/{pending,receive,subscriptions,state,lifecycle,handshake}.ts` |
| Remote lanes | DM-18, DM-19, DM-20 | `electron/hosts/remote-lanes.ts` → `remote-lanes/{hydration,state,ownership,reads,commands}.ts` |
| Lane projection | LR-16 | `libs/session-runtime/src/lanes/projection.ts` → explicit state + reducers |
| Host API transport | HB-10 | `apps/host/src/api/server.ts` → `server-{http,sockets,lifetime}.ts` |
| Control auth/static/routing | CT-02..CT-09, SB-02 | `apps/control/src/app.ts`, `static.ts`, `routes/*` → typed route catalog, split handlers |
| Renderer shell + stores | DKA-* (28) | `apps/desktop/src/app/*`, `apps/desktop/src/stores/*` |

## Proposed rule: one extraction, one owner, no parallel rewrites
1. Per area, exactly one lane performs the extraction. Proposed default: **remediation extracts** (pure moves,
   behaviour pinned by characterization tests; wire contracts frozen by FD-09/FD-10 freeze tests), each area
   as its own small PR merged to main.
2. **PWA lane does not edit those files** until the area's extraction PR merges; it builds on the new modules.
3. After merge, **ownership of the new modules passes to the PWA lane**; remediation does not touch them again.
4. Any area the PWA lane must change first (e.g. a shared browser-safe Host client in `libs/`), it **claims here
   before starting**; remediation then drops or rebases its units for that area instead of re-splitting.
5. Contracts (IPC, Host protocol, Control API) change only in the lane that owns the area, with the freeze tests
   updated in the same PR.

## Needed from the PWA lane
- Which areas it needs to change, and whether it wants a shared client/projection module extracted into `libs/`
  (that changes the target shape of DM-15–20 and LR-16).
- Preferred order, so the areas it needs first are extracted first.

## Earlier PWA lane response (superseded by the owner decision above)

Source: session 01a12645-07f3-76d5-bc5e-80d0c53a61ff, branch `agustin/mobile-pwa`, base `11691e66`. The PWA worktree is clean; no production files have been edited. This response changes no execution manifest or unit state in the remediation lane.

We accept one owner per extraction, main-based integration, frozen existing contracts and no parallel rewrites. We do need shared browser-safe libraries, not only smaller Desktop modules.

### Claims and sequence

| Area | Owner / requested next action |
|---|---|
| Foundation and test relocation | Remediation finishes and lands these first. PWA does not edit their package/config/CI/test-move files or publish new roots during the freeze. |
| Host connection and remote lanes (DM-15..20) | PWA claims the shared extraction into `libs/host-client/src/`, retaining thin Desktop adapters/facades. Do not perform a competing Desktop-only extraction. Preserve the unit characterization, pending receipt, stream ordering, timer cleanup, fencing and size requirements in the PWA implementation. DM-18's terminal-only test splitting can remain remediation-owned once its fixture ownership is explicitly separated from remote-lane tests. |
| Projection (LR-16) | PWA claims the browser-safe projection destination in `libs/host-client/src/`, with a compatible `session-runtime` re-export or adapter for existing callers. No browser library may import `session-runtime`. Preserve existing semantics and LR-16's explicit-state/reducer goals. Check package dependency direction before moving it. |
| Host API admission (HB-10) | Remediation may prioritize the HB-06/HB-09/HB-10 chain after relocation, preserving `requestStatus`/`startApi` public entries and today's Origin refusal. Once merged, hand the admission seam to PWA for exact app-Origin support. No weakening of grants, challenge proof, loopback binding or native clients. |
| Control (CT-02..09, SB-02) | Prefer remediation's stable auth/routing/static seams first, including verified token session identity. PWA owns new browser-session modules, then integrates through those seams after their changes land. Keep the site's script-free CSP distinct from the React app's policy. Please report the minimal dependency chain, including CT-12/13 image work, before dispatch: the PWA image/static-root change also overlaps those files. No need to transfer unrelated enrollment/schema work to PWA. |
| Renderer physical move | PWA owns the single mechanical move into `libs/client-ui/src/`, with renderer tests in `libs/client-ui/test/` after the initial test relocation. Desktop bootstrap/platform adapters remain app-owned. Do not start another renderer move. |
| Renderer behavior refactors | The current hold on DKA alone is insufficient during the move: desktop-chat, desktop-features, shared components, mock/dev importers and renderer tests also change paths. Reserve a short renderer-wide path freeze for the PWA move, then remap the pending unit ownership manifests once. Remediation keeps its non-overlapping behavior fixes/refactors at the final paths; PWA owns compact shell/navigation/adaptive primitives. Agree exact per-file ownership before either lane changes a shared component or store. Do not silently drop those fixes. |
| New web root and validation wiring | PWA owns `apps/web` and the new client libraries. Root package/Nx/typecheck/Vitest/CI integration follows foundation+relocation and is serialized with TL-04/05/06 and cleanup. New roots must be discovered by all required checks; standalone probe results are not production coverage. |

Priority after foundation/relocation: (1) Host admission and Control auth/static integration seams, in parallel with PWA's browser-safe Host-client work; (2) one short shared-renderer move and manifest remap; (3) compact shell/browser adapter and shared conformance/E2E. We should not wait for all 535 remediation units, or do the same extraction twice.

### Safe work immediately

PWA may develop isolated browser feasibility/proof fixtures and new browser-only modules without touching held source, root tooling or deployment. These are not merged until integrated discovery/typecheck/tests are wired after the freeze. Actual phone OAuth/Tailscale testing remains a release gate; no Host restarts or production configuration changes are authorized by this coordination.

Please acknowledge the claims, identify any additional dependency/ownership conflicts, and update your unit manifests yourself. Until then, existing overlap holds stay in place. This is an ownership proposal/claim, not evidence that the two-lane handoff has completed.

## Remediation lane acknowledgment (2026-10-18)

Acknowledged: PWA ships first. Remediation manifests are updated accordingly.
- Foundation landed as #511 (`1d388d82`): CI now enforces the size ratchet (any growth of an already-oversized
  file/function fails), the comprehensive `npm run typecheck` (needs `npm ci --prefix apps/site`), and freeze
  tests for IPC channels, Host protocol frames/ops, Control routes and status keys. A PWA change to any frozen
  contract updates the freeze baseline in the same PR.
- Test relocation (RL-02/RL-03) is deferred until after PWA deploys. RL-01 (a dry-run planner, no file moves) may
  still merge. Remediation keeps tests colocated meanwhile.
- Held for PWA (no remediation edits): DM-15..20, LR-16, HB-06, HB-09, HB-10, HB-11, CT-02..09, CT-12..15, SB-02,
  all renderer units (apps/desktop/src/**: desktop-chat, desktop-core, desktop-features), and root config/CI units.
- Remediation proceeds on: Host internals outside `apps/host/src/api/{server,connection,lanes}*`, libs
  (except lanes/projection), Desktop main process outside `electron/hosts/{connection,remote-lanes}*`, e2e fixtures,
  site, tooling. If PWA needs to touch one of these, claim it here and remediation will drop or rebase its unit.

## Remediation update (2026-10-18, later)

- Host PR #517 (Host internals) is open. HB-23 (Host config schema split) was pulled out because PWA edits
  `apps/host/src/config/schema.ts` (`api.webOrigin`); it relands after PWA. Trial merge of PWA onto #517:
  the only conflict is adjacent lines in `tools/budgets/host.json`; keep both sides (PWA raises, remediation removes).
- Newly held because the PWA branch edits them: DM-23 (`electron/hosts/routines.ts`), DM-26
  (`electron/hosts/read-features.ts`), ST-02 (`apps/site/src/styles/global.css`), TL-09 (`tools/scripts/validate.sh`),
  libs:worktree-segment and libs:print-mode (lib `package.json`), DE-01 (`apps/desktop/package-boundary.test.ts`),
  and any unit owning other files under `electron/hosts/` that PWA changes.

## Remediation update (2026-10-18, wave 2)

- Desktop main PR #518 adds one paragraph to `docs/architecture.md` (DM-01 IPC sender admission) near lines
  PWA edits; resolve by keeping both. Budget JSON conflicts (`tools/budgets/*.json`) are always mechanical:
  keep PWA's raises and remediation's removals.
- Libs PR changes `docs/provider-symmetry.md` (the relocated directives test path; prettier reflows the
  table). PWA also reflows that table: keep PWA's rows, apply the one path change, rerun prettier.
- TL-08 (Control-to-Desktop Nx edge) is held: PWA rewrites the same affected-set tests. Relands after PWA.

## Wave 3 note (libs-3)
- After PWA lands: README.md:307-308 ("IpcInvokeMap" contract line), README repo tree `ipc.ts` row, docs/routines.md:315 and docs/worktrees.md:146 should name `libs/shared/src/ipc/<group>.ts` (LS-04 split). Held to avoid conflicts with PWA's adjacent edits.
- After PWA: docs/known-issues.md HL1/HL2 code-location column should name apps/host/src/lanes/runtime-host/model-switch.ts (HA-17 split); held because PWA edits that table.
