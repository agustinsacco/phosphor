# Engineering remediation: status and handoff

A deep engineering-standards review of every app and library (October 2026)
produced a plan of 538 small, test-first refactor and fix units. This file says
what has landed, what is left, and how to continue. Like
[known-issues.md](known-issues.md), it is a labelled exception to the
present-tense rule: delete it when the last unit merges.

## Where it stands

**188 of 538 units are merged, 349 remain, and one (DM-26) was replaced by its split.** Main was green and released when this was
written: Desktop auto-released, Host `host-v0.2.10`, and Deploy Site succeeded.

| Group              | Merged | Left | Notes                                                      |
| ------------------ | -----: | ---: | ---------------------------------------------------------- |
| fixes (D/X series) |     21 |    0 | Review defects, all fixed                                  |
| foundation         |     14 |    0 | Typecheck coverage, contract freezes, size ratchet, gates  |
| libs               |     41 |   12 | shared, session-runtime, pi-extensions, host-client        |
| host               |     61 |   21 |                                                            |
| desktop-main       |     41 |   21 | `apps/desktop/electron`; three WIP branches below          |
| tooling            |      7 |   11 |                                                            |
| control / site     |      1 |   23 | Mostly `apps/control`; needs the local Supabase stack      |
| desktop-core       |      0 |   77 | Renderer, now in `libs/client-ui` (shared with `apps/web`) |
| desktop-chat       |      0 |   65 | Renderer chat surfaces in `libs/client-ui`                 |
| desktop-features   |      0 |   86 | Renderer feature surfaces in `libs/client-ui`              |
| desktop-e2e        |      0 |   26 | Desktop Playwright suite                                   |
| reloc              |      2 |    2 | Moving unit tests into `test/` folders: runs LAST          |
| cleanup            |      0 |    5 | Final alias/leftover removal after relocation              |

The PRs that landed it are #506, #508, #509, #511–#513, #515–#535. Their
descriptions list every unit and each one's single behaviour change, where it
has one. Two need calling out:

- **#506 (fixes):** fixed the review's real defects, D1–D10 and the X series.
- **#533 (Host CLI):** prototype names like `phosphor constructor` now exit 64,
  `unknown command`.

The renderer groups are untouched because the mobile-PWA lane (#514) moved the
renderer from `apps/desktop/src` to `libs/client-ui` mid-flight. Every remaining
spec was re-validated against post-PWA main (`c08625cc`): 240 path remaps and
50 redesigns. None were dropped, because every finding still reproduces.

## Where the plan lives

- **Full specs:** branch `remediation-kit` on origin (`plans/program.json`).
  Each unit has `owns` (the only paths it may change), `design`,
  `characterize_first`, `new_tests`, `existing_tests`, `verify` (shell
  commands), `acceptance` and `depends_on`. A `replan` field holds the
  post-PWA evidence.
- **Status:** `exec/state.json` on the same branch. `exec/tasks.json` groups
  units into coder tasks.
- **Scripts, coder and reviewer protocols, and the decision log:** the same
  branch (`tools/`, `exec/PROTOCOL-*.md`, `EXECUTION.md`). Its README explains
  each script.
- **Unit index:** the tables at the end of this file.

## How a unit is done

1. **Characterize first.** The first commit is `test(<ID>): characterize …`. It
   contains only tests, drives the original public entry and passes on the unchanged
   code. After that commit, nothing it added may be edited.
2. **Fix, security and perf units only:** next comes
   `test(<ID>): regression …`, which must fail on the base by assertion.
3. **Then the change.** Decompose units change no behaviour and keep public
   entries stable. Every new module gets its own tests.
4. **Budgets.** A source file is at most 400 lines, a function at most 80 and a
   test file at most 800. The ratchet in `tools/budgets/*.json` is enforced in
   CI and may only go down. After a PR, `tighten-budgets.mjs` removes ceilings
   that were paid off.
5. **Ownership.** Touch only `owns`. A test that must follow a moved import
   gets a mock-path-only exception, recorded in the spec's `notes`.
6. **Contracts.** Never change IPC channels, the `libs/shared` protocol, status
   keys or Host/Web wire shapes unless the spec says so. `apps/web`,
   `libs/host-client` and the Host API are web-exposed.

The loop that worked: a coder per task (`gpt-6.1-sol` for most, Opus for risky
ones) runs the unit gate until it passes. An independent reviewer then gives a
verdict. The integrator cherry-picks approved units into one PR per area and
fixes review minors in its own commit, then runs the full local gate:

- typecheck for every project, lint, `prettier --check .` and full vitest;
- `npm run build` and `npm run build:host`;
- Desktop e2e when IPC or UI flow changed, and `npm run test:e2e:web` when
  `libs/host-client` or `libs/client-ui` changed.

It merges only at 12/12 CI, squash, with `--match-head-commit`.

## Releasing

- Desktop releases itself after green CI on main.
- Deploy Site is path-triggered. It fails with "Deployment SHA is not the exact
  current main checkout" when a later merge lands first. Re-run it with
  `gh workflow run "Deploy Site" --ref main -f confirm=true`.
- Host releases itself after green CI on main when the Host changed since the
  newest `host-v*` tag (next patch version). To force one:
  `gh workflow run "Host Release" --ref main` (optionally `-f version=X.Y.Z`).
- If main goes red, fix it in its own PR before merging anything else.

## Next steps, in order

0. **Re-check the plan against main first.** The remaining specs were audited
   against main at `488d5afe`. Feature work since then (PWA, Host machines)
   moves files they name. Before resuming, rerun the read-only audit the
   re-plan used: one auditor per group compares each unit's `owns`, paths and
   acceptance commands with current main, and answers remap, rewrite or drop.
   Apply the answers to `plans/program.json` by unit id, never by array index.
   A WIP branch whose files the feature work rewrote is cheaper to redo from
   its spec than to rebase.
1. **Finish the WIP branches**, all based on `488d5afe`. Rebase each, rerun
   its unit gates, have it reviewed, then integrate:
   - `remediation-wip/DM-08`: DM-08 and DM-09. Both are coded and their gates pass.
     DM-08's `owns` now includes `ipc/hosts-handlers.test.ts`, for its mock path.
   - `remediation-wip/DM-15`: DM-15 and DM-16 are coded; DM-17 is not
     started. This touches `libs/host-client/src/connection.ts`, which is
     web-exposed.
   - `remediation-wip/DM-18`: approved, but held. Its new
     `apps/desktop/electron/hosts/__fixtures__/*.ts` helpers import
     `@shared/host-protocol-testing`. `libs/shared/src/host-protocol-testing/boundary.test.ts`
     treats any non-`*.test.*` file as production source. Fix it by keeping the
     kit import inside the test files, not by widening the boundary.
   - `remediation-wip/DM-26b` and `remediation-wip/TL-04`: only the
     characterization commit exists. Restart from it.
2. **Non-renderer ready set:**
   - tooling: TL-06, TL-07, TL-09, TL-14;
   - libs: LR-04;
   - desktop-main: DM-49, DM-50, DM-54, DM-56;
   - host: HA-39, HB-06, HB-09, HB-11, HB-23, HB-26, HB-27;
   - desktop-e2e: DE-01;
   - site: ST-02.

   Then the control group, which needs the local Supabase stack.

3. **Renderer** (desktop-core, then desktop-chat and desktop-features): 56
   tasks are ready now. Each touches `libs/client-ui`, so run the web e2e as
   well as Desktop e2e.
4. **Relocation, last** (RL-02, then RL-03, then cleanup). It moves every unit
   test into mirrored `test/` folders. It runs last because the specs above
   still name colocated test paths. RL-03's ownership is generated from the RL-02
   plan at dispatch. Before it runs, it must keep these paths working:
   - the macOS signing test path in `ci.yml`;
   - `apps/host/src/__fixtures__/fake-pi.cjs`;
   - the `real-session-events.jsonl?raw` import in `mockPhosphor.ts`;
   - the packaging `!*.test.ts` filter.
     The `ready-tasks.cjs` script lists `RL-01+RL-02` as ready. Ignore it until
     everything else has merged.

## Follow-ups found along the way

- Adopt the new shared helpers in the apps:
  - `runPrintMode` from `@phosphor/session-runtime/pi/print-mode`;
  - `@phosphor/shared/worktree-segment`;
  - the shared `resolvePiInvoker` in `pi/mcp-actions.ts` and `pi/auth-actions.ts`.
- `ttl-cache` `invalidate()` does not detach a load already in flight.
- The fake-host test helper is copied four times; move it into one `__fixtures__/` file.
- `tools/scripts/capture-readme-shots.mjs` times out on `getByTitle('Artifacts pane')`.
  This predates the remediation.
- SB-01's proposed migration timestamp collides with the merged Web migration.
  Pick a new one when it is dispatched.

## Known load flakes

These pass when run alone. Re-run one in isolation before assuming a change broke it:

- the `setup.test.ts` 64 KiB case;
- the real-Git cases in `worktree.test.ts`;
- `hydrationScale.test.ts`;
- `.run-lock-recovery` in `run.test.ts`;
- "pushes sessions:changed" in `session-watcher.test.ts`.

CI's unit job runs about 14k tests. A case near the 5 s default needs an
explicit timeout (#530).

## Lessons

- **Apply plan patches by unit id, never by array index.** An insertion shifts
  indices and silently gives units their neighbour's spec. This happened once
  and was caught by coders.
- After a workspace is added (the PWA added `client-ui`, `host-client` and
  `apps/web`), every worktree needs a fresh `npm ci`, or `node_modules` clone.
- Keep one area per PR and merge small. Never merge on a red main.

## Remaining units

### tooling (11)

| Unit  | Kind      | Risk   | Title                                                                                                                                 | Depends on   |
| ----- | --------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| TL-01 | security  | high   | Pin Actions to reviewed commit identities and enable update automation                                                                | -            |
| TL-02 | security  | high   | Minimize workflow credentials and correctly key nested installation caches                                                            | TL-01        |
| TL-03 | perf      | medium | Use mapped virtual-display windows in Linux CI and retain flaky-test evidence                                                         | TL-02, DE-06 |
| TL-04 | tooling   | high   | Remove unnecessary root Desktop dependencies with installation-closure proof **WIP: `remediation-wip/TL-04 (characterization only)`** | -            |
| TL-05 | tooling   | medium | Centralize bundler aliases and stop leaking Desktop @ into portable tsconfigs                                                         | TL-04        |
| TL-06 | tooling   | medium | Align development Node floor and Node types without changing shipped runtime                                                          | TL-04        |
| TL-07 | security  | high   | Make Desktop installer checksum verification fail closed                                                                              | -            |
| TL-09 | fix       | low    | Bring local CONTROL_DB validation to CI parity                                                                                        | -            |
| TL-10 | dead-code | high   | Remove obsolete Windows smoke and pre-relocation release fallback                                                                     | TL-02        |
| TL-11 | docs      | low    | Correct verified living-document drift without deleting unverified issues                                                             | TL-07, TL-09 |
| TL-14 | decompose | medium | Extract CI baseline selection without changing conservative fallback                                                                  | -            |

### libs (12)

| Unit                  | Kind           | Risk | Title                                                                                | Depends on         |
| --------------------- | -------------- | ---- | ------------------------------------------------------------------------------------ | ------------------ |
| LR-04                 | dedupe-extract | high | Extract common trunk/start-point and conservative merge proof                        | -                  |
| libs:git-worktrees    | dedupe-extract | high | Extract hardened worktree preparation and rollback                                   | LR-04              |
| libs:sqlite-loader    | dedupe-extract | high | Consolidate SQLite loading with sync/async compatibility policies                    | libs:git-worktrees |
| LR-05                 | dedupe-extract | high | Pin both routine runners and extract settlement observation                          | libs:sqlite-loader |
| libs:routine-executor | dedupe-extract | high | Extract portable routine execution orchestration behind machine ports                | LR-05              |
| LR-06                 | dedupe-adopt   | high | Adopt canonical wire constants inside extension producers                            | -                  |
| LR-07                 | dedupe-adopt   | high | Replace bundled extension API duplicates with typed facets                           | LR-06              |
| LR-08                 | dedupe-adopt   | high | Adopt pi API facets in budget and Node-free control helpers                          | LR-06              |
| LR-09                 | decompose      | high | Extract artifact pure branch/edit helpers and foreign-store reads                    | LR-07              |
| LR-10                 | decompose      | high | Replace artifact extension mega-closure with explicit session state and tool modules | LR-09              |
| LR-12                 | decompose      | high | Separate context measurement from publisher lifecycle state                          | LR-07, LR-08       |
| LR-14                 | decompose      | high | Make Headroom handler state explicit without changing lossless/fail-open policy      | LR-07              |

### desktop-main (21)

| Unit   | Kind         | Risk   | Title                                                                                                                                          | Depends on            |
| ------ | ------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| DM-08  | decompose    | high   | Move Host runtime composition and lifetime out of hosts IPC **WIP: `remediation-wip/DM-08 (DM-08+DM-09 coded, gates pass, not reviewed)`**     | -                     |
| DM-09  | decompose    | high   | Extract remote IPC routing and finish thin Host registrars **WIP: `remediation-wip/DM-08`**                                                    | DM-08                 |
| DM-12  | decompose    | high   | Move routine validation and operations behind thin IPC callbacks                                                                               | DM-09                 |
| DM-15  | decompose    | high   | Extract Host pending receipts, calls and ordered replay **WIP: `remediation-wip/DM-15 (DM-15, DM-16 coded, not reviewed; DM-17 not started)`** | -                     |
| DM-16  | decompose    | high   | Split authenticated Host frame reception by stream domain **WIP: `remediation-wip/DM-15`**                                                     | DM-15                 |
| DM-17  | decompose    | high   | Make Host connection handshake and lifecycle explicit state                                                                                    | DM-16                 |
| DM-18  | tests        | medium | Split oversized remote-lane and terminal suites before pinning refactors **WIP: `remediation-wip/DM-18 (approved; held, see below)`**          | -                     |
| DM-19  | decompose    | high   | Extract remote lane projection hydration and push delivery                                                                                     | DM-18                 |
| DM-20  | decompose    | high   | Split remote lane ownership, reads and RPC dispatch                                                                                            | DM-19, DM-17          |
| DM-21  | decompose    | high   | Extract remote terminal admission and retained cleanup intent                                                                                  | DM-18                 |
| DM-22  | decompose    | high   | Extract terminal stream synchronization and bounded input queue                                                                                | DM-21, DM-17          |
| DM-26b | decompose    | high   | Split Desktop repository operation admission and command binding **WIP: `remediation-wip/DM-26b (characterization only)`**                     | -                     |
| DM-42  | decompose    | high   | Extract BrowserWindow construction and navigation guards from bootstrap                                                                        | -                     |
| DM-49  | dedupe-adopt | high   | Adopt shared title policy behind the stable Desktop entry                                                                                      | -                     |
| DM-50  | dedupe-adopt | high   | Adopt shared print-mode process runner                                                                                                         | -                     |
| DM-51  | dedupe-adopt | high   | Bind shared worktree operations to Desktop GitHub proof ports                                                                                  | libs:git-worktrees    |
| DM-52  | dedupe-adopt | high   | Adopt shared routine executor with Desktop ownership and review hooks                                                                          | libs:routine-executor |
| DM-54  | dedupe-adopt | low    | Adopt shared worktree-folder predicate in preference reads                                                                                     | -                     |
| DM-56  | decompose    | high   | Type Desktop push delivery and remove duplicated broadcast loops                                                                               | -                     |
| DM-58  | dead-code    | low    | Remove the orphaned idle-reaper PTY query                                                                                                      | DM-56                 |
| DM-59  | docs         | low    | Close Desktop layering and documentation drift after migrations                                                                                | DM-42, DM-09          |

### host (21)

| Unit         | Kind         | Risk   | Title                                                                             | Depends on            |
| ------------ | ------------ | ------ | --------------------------------------------------------------------------------- | --------------------- |
| HA-37        | dedupe-adopt | high   | Adopt portable routine executor through Host-only ports                           | libs:routine-executor |
| HA-38        | dedupe-adopt | high   | Adopt hardened shared worktree and merged-branch helpers                          | libs:git-worktrees    |
| HA-39        | dedupe-adopt | high   | Adopt shared title policy and stdin-closed print runner without changing attempts | -                     |
| HA-40        | fix          | high   | Fix extension-provider naming with the shared bounded attempt plan                | HA-39                 |
| HA-41        | dedupe-adopt | high   | Adopt the shared serialized SQLite loader                                         | libs:sqlite-loader    |
| HB-06        | tests        | medium | Replace API test wall-clock races and split listener suites                       | -                     |
| HB-09        | decompose    | high   | Separate connection authentication and frame handling with explicit state         | -                     |
| HB-10        | decompose    | high   | Split API listener admission, WebSocket transport and lifetime                    | HB-06, HB-09          |
| HB-11        | decompose    | high   | Split authenticated lane adapter into peer, subscription and request handlers     | -                     |
| HB-15        | decompose    | high   | Extract run resource state and shutdown coordination                              | -                     |
| HB-16        | decompose    | high   | Split daemon initialization into storage, lane wiring and network startup         | HB-15, HB-10, HB-11   |
| HB-23        | decompose    | high   | Split config validation by domain while preserving ordered diagnostics            | -                     |
| HB-24        | decompose    | high   | Split setup detection and atomic publication                                      | HB-23                 |
| HB-25        | decompose    | high   | Split guided setup into resumable prerequisite and provider steps                 | HB-24                 |
| HB-26        | decompose    | high   | Separate Linux and macOS service action handlers                                  | -                     |
| HB-27        | decompose    | high   | Split enrollment preparation, polling and identity commit                         | -                     |
| HB-29        | decompose    | high   | Split verified release preparation from synchronous selection                     | HB-26                 |
| HB-30        | decompose    | high   | Separate uninstall preflight and bounded removal                                  | HB-29                 |
| HB-31        | dedupe-adopt | medium | Adopt shared Tailscale facts with a compatibility Host projection                 | -                     |
| HB-TS-STRICT | fix          | medium | Require MagicDNS and a usable Tailscale HTTPS certificate domain                  | HB-31, HB-25          |
| HB-36        | docs         | low    | Document accepted grant replay window                                             | HB-09, HB-10          |

### control (17)

| Unit  | Kind      | Risk   | Title                                                                      | Depends on                 |
| ----- | --------- | ------ | -------------------------------------------------------------------------- | -------------------------- |
| CT-02 | fix       | high   | Add allowlisted internal and upstream diagnostics                          | -                          |
| CT-03 | decompose | high   | Consolidate Host-context auth and object checks; retain browser fetch port | CT-02                      |
| CT-04 | decompose | high   | Carry verified-token session identity through user authentication          | CT-03                      |
| CT-05 | decompose | high   | Split enrollment handlers with explicit per-app guess reservations         | CT-03                      |
| CT-06 | decompose | high   | Separate client lifecycle and grant payload construction from wiring       | CT-04                      |
| CT-07 | decompose | high   | Drive API registration and 405s from a single typed route catalog          | CT-02, CT-05, CT-06        |
| CT-08 | decompose | high   | Split static resolution from streaming while preserving confinement        | -                          |
| CT-09 | security  | medium | Apply script-free framing-resistant site CSP                               | CT-08, CT-13               |
| CT-10 | fix       | low    | Build smoke-test server into disposable output                             | -                          |
| CT-11 | tests     | high   | Replace Desktop imports with Control-owned stack auth fixture              | CT-03                      |
| CT-12 | fix       | high   | Inject immutable build identity into health                                | CT-03, CT-10, SB-03        |
| CT-13 | security  | high   | Pin and minimize combined build/runtime image                              | CT-12                      |
| CT-14 | docs      | low    | Correct logging/deployment docs and record hosted migration preflight      | CT-02                      |
| SB-01 | security  | high   | Default-deny future Control function execution                             | CT-14                      |
| SB-02 | perf      | high   | Make account guard read-mostly while preserving first-use provisioning     | SB-01, CT-04, CT-11        |
| SB-03 | fix       | high   | Move bounded retention to a service-role maintenance RPC                   | SB-02                      |
| CT-15 | fix       | high   | Run jittered retention independently of requests                           | SB-03, CT-12, CT-09, CT-02 |

### site (6)

| Unit  | Kind      | Risk   | Title                                                                | Depends on          |
| ----- | --------- | ------ | -------------------------------------------------------------------- | ------------------- |
| ST-01 | dead-code | low    | Remove unused historical screenshots, retaining crop sources         | CT-14               |
| ST-02 | decompose | medium | Split global CSS with frozen visual evidence                         | -                   |
| ST-03 | decompose | medium | Extract landing sections preserving markup and anchors               | ST-02               |
| ST-04 | fix       | low    | Provide an accessible branded 404 page                               | CT-15, ST-05        |
| ST-05 | fix       | medium | Generate social preview in build output, never tracked public assets | ST-01               |
| ST-06 | docs      | low    | Align remote-access copy with current shipped boundary               | ST-03, ST-04, ST-05 |

### desktop-core (77)

| Unit             | Kind           | Risk   | Title                                                                          | Depends on                                                                                                                                                                                                                                                     |
| ---------------- | -------------- | ------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DKA-FF           | fix            | high   | Handle detached IPC failures and make workspace watches retryable              | -                                                                                                                                                                                                                                                              |
| DKA-FF-PREFS     | fix            | medium | Adopt detached-error handling in leaf preferences and connector cancellation   | DKA-FF                                                                                                                                                                                                                                                         |
| DKA-FF-STORES    | fix            | medium | Adopt detached-error handling in workspace, draft, worktree and dialog writes  | DKA-FF                                                                                                                                                                                                                                                         |
| DKA-FACT6        | docs           | low    | Correct store location and terminal keying documentation                       | -                                                                                                                                                                                                                                                              |
| DKA-LEFTOVERS    | dead-code      | low    | Remove stale orchestrator references from core comments                        | DKA-FF                                                                                                                                                                                                                                                         |
| DKA-PATH         | dedupe-adopt   | medium | Adopt shared worktree-segment policy                                           | DKA-LEFTOVERS                                                                                                                                                                                                                                                  |
| DKA-MARKER       | dedupe-adopt   | medium | Use shared marker recognition for lane notice excerpts                         | -                                                                                                                                                                                                                                                              |
| DKA-EXTCMD       | dedupe-extract | high   | Extract pure extension registration predicate and adopt in Swarm               | -                                                                                                                                                                                                                                                              |
| DKA-S1           | decompose      | high   | Extract session types, shared runtime state and push dispatch                  | DKA-LEFTOVERS                                                                                                                                                                                                                                                  |
| DKA-S2           | decompose      | high   | Extract prefs-mirrored session slice with edit-generation fencing              | DKA-S1                                                                                                                                                                                                                                                         |
| DKA-S3           | decompose      | high   | Extract session catalogue and bounded workspace watching                       | DKA-S2                                                                                                                                                                                                                                                         |
| DKA-S4           | decompose      | high   | Extract bootstrap metadata, command refresh and naming                         | DKA-S3                                                                                                                                                                                                                                                         |
| DKA-S5           | decompose      | high   | Extract session creation and transcript resume phases                          | DKA-S4, DKA-EXTCMD                                                                                                                                                                                                                                             |
| DKA-S6           | decompose      | high   | Extract single and bulk delete coordination                                    | DKA-S5                                                                                                                                                                                                                                                         |
| DKA-S7           | decompose      | high   | Finish session lifecycle and navigation slices behind stable facade            | DKA-S6                                                                                                                                                                                                                                                         |
| DKA-F1           | decompose      | medium | Extract files explorer projection and reuse dirname                            | DKA-PATH                                                                                                                                                                                                                                                       |
| DKA-F2           | decompose      | medium | Extract file tab navigation and model-release actions                          | DKA-F1                                                                                                                                                                                                                                                         |
| DKA-F3           | decompose      | high   | Extract file save/conflict transitions and finish store composition            | DKA-F2                                                                                                                                                                                                                                                         |
| DKA-REMOTE       | decompose      | high   | Split remote lane navigation and listener reconciliation                       | DKA-S7                                                                                                                                                                                                                                                         |
| DKA-EXTUI        | decompose      | high   | Split extension requests and toast clock actions                               | DKA-FF-STORES                                                                                                                                                                                                                                                  |
| DKA-ARTIFACT     | decompose      | medium | Extract artifact projection and pane-selection actions                         | -                                                                                                                                                                                                                                                              |
| DKA-DRAFT        | decompose      | high   | Extract draft persistence and action bindings                                  | DKA-FF-STORES                                                                                                                                                                                                                                                  |
| DKA-WORKSPACE    | decompose      | high   | Split workspace actions and sandbox mutations                                  | DKA-FF-STORES, DKA-S7                                                                                                                                                                                                                                          |
| DKA-TERMINAL     | decompose      | high   | Extract terminal tab actions without changing ownership                        | -                                                                                                                                                                                                                                                              |
| DKA-CHAT         | decompose      | medium | Extract chat store actions without touching reducer semantics                  | -                                                                                                                                                                                                                                                              |
| DKA-WORKTREE     | decompose      | medium | Extract worktree mutation and fetch projection actions                         | DKA-FF-STORES                                                                                                                                                                                                                                                  |
| DKA-ROUTINE      | decompose      | high   | Extract routine refresh state and actions                                      | -                                                                                                                                                                                                                                                              |
| DKA-MODEL        | decompose      | low    | Split model search by query, identity, scoring and presentation                | -                                                                                                                                                                                                                                                              |
| DKA-PREDICT      | decompose      | medium | Make predictor training and lookup state explicit                              | -                                                                                                                                                                                                                                                              |
| DKA-MONACO       | decompose      | medium | Extract bundled worker setup and editor theme configuration                    | -                                                                                                                                                                                                                                                              |
| DKA-APPSTART     | decompose      | high   | Extract shell restore, subscription and readiness effects                      | DKA-S7                                                                                                                                                                                                                                                         |
| DKA-APPSHELL     | decompose      | high   | Split shell rendering and preserve pane portal identity                        | DKA-APPSTART                                                                                                                                                                                                                                                   |
| DKA-SHORTCUT     | decompose      | medium | Split shortcut dispatch by priority and focus scope                            | -                                                                                                                                                                                                                                                              |
| DKA-BOUNDARY     | fix            | medium | Contain render crashes at app and pane boundaries                              | DKA-APPSHELL                                                                                                                                                                                                                                                   |
| DKA-MOCK-APP     | fix            | medium | Start typed browser mock registry and repair app channel responses             | DKA-LEFTOVERS                                                                                                                                                                                                                                                  |
| DKA-MOCK-PI      | fix            | high   | Extract typed mock session RPC and replay                                      | DKA-MOCK-APP                                                                                                                                                                                                                                                   |
| DKA-MOCK-AUTH    | fix            | medium | Extract typed mock Claude, provider-login and package channels                 | DKA-MOCK-PI                                                                                                                                                                                                                                                    |
| DKA-MOCK-HOST    | fix            | high   | Extract typed mock account, control and Host handlers                          | DKA-MOCK-AUTH                                                                                                                                                                                                                                                  |
| DKA-MOCK-FS      | fix            | medium | Extract typed mock files, clipboard and artifact handlers                      | DKA-MOCK-HOST                                                                                                                                                                                                                                                  |
| DKA-MOCK-GIT     | fix            | medium | Extract typed mock git, session catalogue and tree fixtures                    | DKA-MOCK-FS                                                                                                                                                                                                                                                    |
| DKA-MOCK-CONFIG  | fix            | medium | Extract typed mock MCP, pi configuration and skills handlers                   | DKA-MOCK-GIT                                                                                                                                                                                                                                                   |
| DKA-MOCK-MISC    | fix            | medium | Extract remaining typed mock prefix handlers and event adapters                | DKA-MOCK-CONFIG                                                                                                                                                                                                                                                |
| DKA-MOCK-ROUTINE | fix            | medium | Replace routine mock switch with typed per-channel actions                     | DKA-MOCK-MISC                                                                                                                                                                                                                                                  |
| DKA-MOCK-CLOSE   | fix            | medium | Enforce complete typed browser mock coverage and remove legacy dispatcher      | DKA-MOCK-ROUTINE                                                                                                                                                                                                                                               |
| DKB-01           | tests          | high   | Pin Sidebar public-entry behavior before any extraction                        | -                                                                                                                                                                                                                                                              |
| DKB-02           | decompose      | high   | Extract and subdivide saved Sidebar rows                                       | DKB-01                                                                                                                                                                                                                                                         |
| DKB-03           | decompose      | high   | Extract pending row and workspace switcher without changing their lifetimes    | DKB-02                                                                                                                                                                                                                                                         |
| DKB-04           | decompose      | high   | Extract local workspace-group presentation and menus                           | DKB-03                                                                                                                                                                                                                                                         |
| DKB-05           | decompose      | high   | Separate Sidebar discovery, projections and bounded effects                    | DKB-04                                                                                                                                                                                                                                                         |
| DKB-06           | decompose      | high   | Isolate Sidebar selection and delete confirmation orchestration                | DKB-05                                                                                                                                                                                                                                                         |
| DKB-07           | decompose      | high   | Finish Sidebar shell, search and workspace-action decomposition                | DKB-06                                                                                                                                                                                                                                                         |
| DKB-08           | perf           | high   | Stabilize Sidebar scan inputs without reordering workspaces                    | DKB-07                                                                                                                                                                                                                                                         |
| DKB-09           | decompose      | medium | Split marker-picker controls from catalog results                              | DKB-21                                                                                                                                                                                                                                                         |
| DKB-10           | perf           | high   | Subscribe to used lane markers only while the picker is mounted                | DKB-08, DKB-09                                                                                                                                                                                                                                                 |
| DKB-11           | decompose      | medium | Split grouping accumulation from presentation                                  | -                                                                                                                                                                                                                                                              |
| DKB-12           | decompose      | medium | Make session-tree layout state explicit                                        | -                                                                                                                                                                                                                                                              |
| DKB-13           | decompose      | high   | Extract session-tree SVG and detail presentation                               | -                                                                                                                                                                                                                                                              |
| DKB-14           | decompose      | high   | Separate session-tree actions and viewport hooks                               | DKB-13                                                                                                                                                                                                                                                         |
| DKB-15           | decompose      | high   | Extract background chat naming from startChat                                  | -                                                                                                                                                                                                                                                              |
| DKB-16           | decompose      | medium | Split bulk-delete confirmation and progress presentation                       | DKB-21                                                                                                                                                                                                                                                         |
| DKB-17           | decompose      | high   | Split remote lane row actions, delete sheets and body                          | DKB-21                                                                                                                                                                                                                                                         |
| DKB-18           | decompose      | high   | Split remote repository-group controls and removal dialog                      | DKB-21                                                                                                                                                                                                                                                         |
| DKB-19           | decompose      | medium | Extract machine choice and activity presentation                               | -                                                                                                                                                                                                                                                              |
| DKB-20           | decompose      | medium | Separate SessionList drag state and sortable rows                              | -                                                                                                                                                                                                                                                              |
| DKB-21           | fix            | high   | Give shared modals semantics and nested-safe focus ownership                   | -                                                                                                                                                                                                                                                              |
| DKB-22           | decompose      | high   | Split tooltip delegation state from floating presentation                      | DKB-21                                                                                                                                                                                                                                                         |
| DKB-23           | decompose      | medium | Separate DOM find indexing, paint registry and reveal geometry                 | -                                                                                                                                                                                                                                                              |
| DKB-24           | decompose      | medium | Extract find keyboard handling and DOM match lifecycle                         | DKB-23                                                                                                                                                                                                                                                         |
| DKB-25           | decompose      | high   | Split Mermaid viewport gestures, toolbar and SVG export                        | DKB-21                                                                                                                                                                                                                                                         |
| DKB-26           | decompose      | high   | Extract popup lifecycle and MenuRow types                                      | DKB-21                                                                                                                                                                                                                                                         |
| DKB-27           | decompose      | medium | Extract ChoiceMenu navigation state and option presentation                    | DKB-26                                                                                                                                                                                                                                                         |
| DKB-28           | decompose      | medium | Extract context-menu surface and keep imperative host stable                   | -                                                                                                                                                                                                                                                              |
| DKB-29           | decompose      | medium | Split code highlighting lifecycle from code-block controls                     | -                                                                                                                                                                                                                                                              |
| DKB-30           | decompose      | high   | Extract markdown link activation and strict Mermaid rendering                  | -                                                                                                                                                                                                                                                              |
| DKB-31           | dead-code      | low    | Remove unused orchestrator icon; retain declaration-list budget exemption      | -                                                                                                                                                                                                                                                              |
| DKB-32           | fix            | high   | Apply shared dialog focus contract to standalone session-tree portal           | DKB-14, DKB-21                                                                                                                                                                                                                                                 |
| DKB-FF           | fix            | medium | Adopt fireAndForget for detached promises in sessions UI and shared components | DKA-FF, DKB-02, DKB-03, DKB-04, DKB-05, DKB-06, DKB-07, DKB-08, DKB-09, DKB-10, DKB-11, DKB-12, DKB-13, DKB-14, DKB-15, DKB-16, DKB-17, DKB-18, DKB-19, DKB-20, DKB-21, DKB-22, DKB-23, DKB-24, DKB-25, DKB-26, DKB-27, DKB-28, DKB-29, DKB-30, DKB-31, DKB-32 |

### desktop-chat (65)

| Unit   | Kind         | Risk   | Title                                                                           | Depends on             |
| ------ | ------------ | ------ | ------------------------------------------------------------------------------- | ---------------------- |
| DCA-01 | perf         | low    | Avoid legacy launch-strip transcript rebuilds while streaming                   | -                      |
| DCA-02 | fix          | low    | Quote nontrivial AWS profile arguments in remediation commands                  | -                      |
| DCA-03 | perf         | high   | Subscribe ChatView directly to session control eligibility                      | -                      |
| DCA-04 | fix          | medium | Bound ErrorBlock subscriptions and share failure-safe user-info loading         | DCA-03                 |
| DCA-05 | fix          | low    | Use ChatImage for all tool-output image affordances                             | -                      |
| DCA-06 | fix          | low    | Surface failed rewound-session navigation                                       | -                      |
| DCA-07 | tests        | low    | Separate hydration benchmarks from deterministic correctness gates              | -                      |
| DCA-08 | decompose    | high   | Extract reducer delta folds with immutable identity behavior pinned             | DCA-07                 |
| DCA-09 | decompose    | high   | Split message-end and linear hydration folds behind reducer facade              | DCA-08                 |
| DCA-10 | decompose    | high   | Reduce top-level event switch to domain dispatchers                             | DCA-09                 |
| DCA-11 | decompose    | high   | Freeze Claude marker parsing behind small compatibility modules                 | DCA-10                 |
| DCA-12 | decompose    | high   | Isolate frozen Claude agent lifecycle folding                                   | DCA-11                 |
| DCA-13 | decompose    | high   | Make transcript grouping state explicit and split row summaries                 | DCA-12                 |
| DCA-14 | decompose    | high   | Extract Claude external activity rows without altering disclosure/find behavior | DCA-13                 |
| DCA-15 | decompose    | high   | Split legacy agent and thought row presentation                                 | DCA-14                 |
| DCA-16 | decompose    | medium | Finish activity group decomposition into model, disclosure and presentation     | DCA-15                 |
| DCA-17 | decompose    | medium | Split message/error rendering while preserving public MessageItem exports       | DCA-04, DCA-16, DCA-02 |
| DCA-18 | decompose    | high   | Extract transcript follow controller without changing scroll timing             | -                      |
| DCA-19 | decompose    | medium | Finish MessageList presentation split and stabilize missing-session projections | DCA-18, DCA-13, DCA-22 |
| DCA-20 | decompose    | high   | Split tool summaries and compact ToolCard label rendering                       | DCA-05                 |
| DCA-21 | decompose    | medium | Separate transcript find segment extraction from counting/cache facade          | DCA-13, DCA-20         |
| DCA-22 | decompose    | high   | Split transcript find orchestration, painting and reveal scheduling             | DCA-21                 |
| DCA-23 | decompose    | high   | Split current-work evidence reconciliation into explicit phases                 | -                      |
| DCA-24 | decompose    | medium | Split current-work indicator summary and detail presentation                    | DCA-23                 |
| DCA-25 | decompose    | high   | Split native subagent tool detail into task, child and management views         | DCA-20                 |
| DCA-26 | decompose    | high   | Split transcript subagent notice projection and disclosure sections             | -                      |
| DCA-27 | decompose    | low    | Separate markdown find-text inline and block folds                              | -                      |
| DCA-28 | decompose    | low    | Split error remedy matching by policy without reordering precedence             | DCA-02                 |
| DCB-01 | decompose    | high   | Mechanically relocate root subagent implementations behind stable facades       | -                      |
| DCB-02 | docs         | low    | Document deliberate raw subagent RPC errors and close H3                        | DCB-01, DCB-03         |
| DCB-03 | fix          | high   | Handle raw rewind-read and queue-drain transport rejection                      | DCB-01                 |
| DCB-04 | perf         | high   | Adopt reactive controller eligibility and stable empty catalogues               | DCB-01, DCA-03         |
| DCB-05 | decompose    | high   | Extract prompt delivery phases from Composer                                    | DCB-04                 |
| DCB-06 | decompose    | high   | Separate composer draft, command and history hooks                              | DCB-05                 |
| DCB-07 | decompose    | medium | Finish Composer with small stable view sections                                 | DCB-06                 |
| DCB-08 | decompose    | medium | Split composer textarea keymap and ghost suggestion lifecycle                   | DCB-01                 |
| DCB-09 | decompose    | medium | Extract file-mention controller and shared composer card sections               | DCB-01                 |
| DCB-10 | decompose    | high   | Separate bounded attachment intake from drag bindings                           | DCB-01                 |
| DCB-11 | decompose    | low    | Split slash key handling and command rows                                       | DCB-01                 |
| DCB-12 | decompose    | high   | Extract provider usage and account switching sections                           | DCB-01                 |
| DCB-13 | decompose    | high   | Extract context composition and pushed status sections                          | DCB-12                 |
| DCB-14 | decompose    | high   | Reduce ContextMeter to view-model and small ring/popover views                  | DCB-13                 |
| DCB-15 | decompose    | medium | Extract model row flattening and rendering primitives                           | DCB-01                 |
| DCB-16 | decompose    | medium | Split model menu controller, key navigation and overlay sections                | DCB-15                 |
| DCB-17 | decompose    | high   | Separate model selection transactions from picker rendering                     | DCB-04                 |
| DCB-18 | decompose    | high   | Split context sources menu into rule and connector sections                     | DCB-01                 |
| DCB-19 | decompose    | medium | Extract image-editor gesture and text-edit transitions                          | DCB-01                 |
| DCB-20 | decompose    | medium | Extract image decoding, canvas effects and save/media operations                | DCB-19                 |
| DCB-21 | decompose    | high   | Finish image-editor shell, stage and keyboard decomposition                     | DCB-20                 |
| DCB-22 | decompose    | low    | Split annotation toolbar control groups                                         | DCB-01                 |
| DCB-23 | decompose    | high   | Separate fleet widget and notice parsers from subagentRuns                      | DCB-01                 |
| DCB-24 | decompose    | high   | Split subagent call/detail parsing and row summaries                            | DCB-23                 |
| DCB-25 | decompose    | high   | Split branch-aware subagent history accumulation                                | DCB-01                 |
| DCB-26 | decompose    | high   | Extract subagent selection and responsive focus lifecycle                       | DCB-02                 |
| DCB-27 | decompose    | medium | Split subagent panel navigation and detail composition                          | DCB-26                 |
| DCB-28 | perf         | high   | Avoid full-history restore read when current native fleet proves target         | DCB-26, DCB-25         |
| DCB-29 | decompose    | high   | Separate subagent preview evidence model and disclosures                        | DCB-01                 |
| DCB-30 | fix          | low    | Report snapshot-index refresh failures without denying saved receipt            | DCB-01                 |
| DCB-31 | decompose    | medium | Split subagent action state and two-line work row presentation                  | DCB-30                 |
| DCB-32 | decompose    | medium | Extract explicit journal loading and recorded launch cards                      | DCB-02                 |
| DCB-33 | decompose    | high   | Share request-correlated widget reply lifecycle                                 | DCB-02, DCB-34         |
| DCB-34 | security     | high   | Use canonical target validator for inspect and stop                             | DCB-02                 |
| DCB-35 | dedupe-adopt | high   | Adopt shared context and headroom status constants                              | DCB-01                 |
| DCB-36 | decompose    | high   | Split session options and rewind picker UI without changing rewind service      | DCB-03                 |
| DCB-37 | dedupe-adopt | medium | Adopt shared extension command registration predicate                           | DCB-02, DKA-EXTCMD     |

### desktop-features (86)

| Unit   | Kind           | Risk   | Title                                                                       | Depends on                                                                                                                                                                                                                                                                                                                                                                             |
| ------ | -------------- | ------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DFA-01 | fix            | low    | Normalize shared async-action IPC failures                                  | -                                                                                                                                                                                                                                                                                                                                                                                      |
| DFA-02 | dedupe-extract | high   | Introduce typed useIpcQuery with request-generation protection              | DFA-01                                                                                                                                                                                                                                                                                                                                                                                 |
| DFA-03 | dedupe-extract | high   | Introduce a shared local-health read resource and hook                      | DFA-02                                                                                                                                                                                                                                                                                                                                                                                 |
| DFA-04 | tooling        | medium | Make settings-index drift checks survive component extraction               | DFA-03                                                                                                                                                                                                                                                                                                                                                                                 |
| DFA-05 | fix            | high   | Share SettingsTab and reject invalid advisor navigation                     | DFA-04                                                                                                                                                                                                                                                                                                                                                                                 |
| DFA-06 | decompose      | medium | Split the settings shell into navigation, content and lifecycle hook        | DFA-05                                                                                                                                                                                                                                                                                                                                                                                 |
| DFA-07 | fix            | high   | Make settings health reads recoverable and shared                           | DFA-03, DFA-06                                                                                                                                                                                                                                                                                                                                                                         |
| DFA-08 | fix            | medium | Handle settings config read and save failures explicitly                    | DFA-07                                                                                                                                                                                                                                                                                                                                                                                 |
| DFA-09 | fix            | high   | Protect update projection from rejected and stale initial reads             | DFA-07, DFA-08                                                                                                                                                                                                                                                                                                                                                                         |
| DFA-10 | decompose      | high   | Extract Claude provider health and proof sections                           | DFA-04, DFA-07                                                                                                                                                                                                                                                                                                                                                                         |
| DFA-11 | decompose      | high   | Extract Claude account list, row and routing controller                     | DFA-10                                                                                                                                                                                                                                                                                                                                                                                 |
| DFA-12 | decompose      | high   | Split subscription accounts rendering from login lifecycle                  | DFA-04, DFA-07                                                                                                                                                                                                                                                                                                                                                                         |
| DFA-13 | decompose      | medium | Split scoped agent settings into controller and section components          | DFA-04, DFA-08                                                                                                                                                                                                                                                                                                                                                                         |
| DFA-14 | decompose      | medium | Extract directive preview and editing sections                              | DFA-04, DFA-08                                                                                                                                                                                                                                                                                                                                                                         |
| DFA-15 | decompose      | medium | Split context-budget and web-access editors into focused sections           | DFA-04, DFA-08                                                                                                                                                                                                                                                                                                                                                                         |
| DFA-16 | decompose      | medium | Split maintenance preferences and report rendering                          | DFA-04, DFA-08                                                                                                                                                                                                                                                                                                                                                                         |
| DFA-17 | decompose      | medium | Split workspace preferences, recent folders and sandbox rows                | DFA-04                                                                                                                                                                                                                                                                                                                                                                                 |
| DFA-18 | decompose      | medium | Split installed-package lists and package editor                            | DFA-04                                                                                                                                                                                                                                                                                                                                                                                 |
| DFA-19 | fix            | medium | Report optimization lifecycle failures and stale workspace reads            | DFA-05, DFA-02                                                                                                                                                                                                                                                                                                                                                                         |
| DFA-20 | decompose      | medium | Split optimization status controls and savings views                        | DFA-04, DFA-19                                                                                                                                                                                                                                                                                                                                                                         |
| DFA-21 | decompose      | low    | Break small settings screens into named presentational sections             | DFA-04, DFA-09                                                                                                                                                                                                                                                                                                                                                                         |
| DFA-22 | decompose      | high   | Extract configured and catalog connector cards                              | DFA-04                                                                                                                                                                                                                                                                                                                                                                                 |
| DFA-23 | decompose      | high   | Move connector orchestration into its feature and share enabled policy      | DFA-22                                                                                                                                                                                                                                                                                                                                                                                 |
| DFA-24 | perf           | high   | Run MCP connection checks once per visit, not per config mutation           | DFA-23                                                                                                                                                                                                                                                                                                                                                                                 |
| DFA-25 | decompose      | high   | Separate MCP migration job sequencing from its plan view                    | DFA-22                                                                                                                                                                                                                                                                                                                                                                                 |
| DFA-26 | decompose      | medium | Extract custom MCP server draft conversion and form fields                  | DFA-22                                                                                                                                                                                                                                                                                                                                                                                 |
| DFA-27 | decompose      | high   | Split connector catalog declarations behind the stable catalog entry        | DFA-22                                                                                                                                                                                                                                                                                                                                                                                 |
| DFA-28 | decompose      | medium | Extract skill detail controller and views without weakening deletion safety | DFA-01                                                                                                                                                                                                                                                                                                                                                                                 |
| DFA-29 | decompose      | medium | Extract skills discovery and library installation cards                     | DFA-28                                                                                                                                                                                                                                                                                                                                                                                 |
| DFA-30 | decompose      | medium | Split skills inventory shell and import sheet                               | DFA-29                                                                                                                                                                                                                                                                                                                                                                                 |
| DFA-31 | decompose      | low    | Split new-skill draft fields from creation orchestration                    | DFA-30                                                                                                                                                                                                                                                                                                                                                                                 |
| DFA-32 | fix            | medium | Normalize skills action errors and catch import-picker rejection            | DFA-01, DFA-31                                                                                                                                                                                                                                                                                                                                                                         |
| DFA-33 | dedupe-adopt   | low    | Consolidate byte labels without changing displayed rounding                 | DFA-16, DFA-30                                                                                                                                                                                                                                                                                                                                                                         |
| DFA-34 | decompose      | high   | Extract generic extension dialog view and keyboard lifecycle                | DFA-03                                                                                                                                                                                                                                                                                                                                                                                 |
| DFA-35 | decompose      | medium | Extract toast host, cards and presentation                                  | DFA-34                                                                                                                                                                                                                                                                                                                                                                                 |
| DFA-36 | dedupe-adopt   | high   | Adopt shared status and snapshot widget keys                                | DFA-35                                                                                                                                                                                                                                                                                                                                                                                 |
| DFA-37 | decompose      | high   | Split approval command rendering without changing deny-first behavior       | DFA-34                                                                                                                                                                                                                                                                                                                                                                                 |
| DFA-38 | decompose      | medium | Extract lane-receipt metadata, facts and action rows                        | DFA-35                                                                                                                                                                                                                                                                                                                                                                                 |
| DFA-39 | decompose      | medium | Split account footer menu and trigger controls                              | DFA-03                                                                                                                                                                                                                                                                                                                                                                                 |
| DFA-40 | tests          | low    | Characterize feedback store, entry button and form                          | DFA-03                                                                                                                                                                                                                                                                                                                                                                                 |
| DFA-41 | decompose      | medium | Split feedback fields, privacy controls and outcome view                    | DFA-40                                                                                                                                                                                                                                                                                                                                                                                 |
| DFA-42 | tests          | medium | Test dictation lifecycle and microphone cleanup without devices             | DFA-03                                                                                                                                                                                                                                                                                                                                                                                 |
| DFA-43 | decompose      | medium | Split command-palette action builders and dialog behavior                   | DFA-03                                                                                                                                                                                                                                                                                                                                                                                 |
| DFA-45 | fix            | high   | Drop transcription results after the dictation owner unmounts               | DFA-42                                                                                                                                                                                                                                                                                                                                                                                 |
| DFB-01 | decompose      | high   | Extract routine list policy, typed starters and lane promotion action       | -                                                                                                                                                                                                                                                                                                                                                                                      |
| DFB-02 | decompose      | medium | Reduce RoutinesPage to list/detail composition and bounded hooks            | DFB-01                                                                                                                                                                                                                                                                                                                                                                                 |
| DFB-03 | perf           | medium | Avoid unrelated local snapshot history reloads                              | DFB-02                                                                                                                                                                                                                                                                                                                                                                                 |
| DFB-04 | decompose      | high   | Pin and extract cron field editing and routine draft predicates             | -                                                                                                                                                                                                                                                                                                                                                                                      |
| DFB-05 | decompose      | high   | Split RoutineEditor form sections and draft/save lifecycle                  | DFB-04                                                                                                                                                                                                                                                                                                                                                                                 |
| DFB-06 | decompose      | medium | Break routine details and activity rows into focused views                  | -                                                                                                                                                                                                                                                                                                                                                                                      |
| DFB-07 | dedupe-adopt   | medium | Extract local machine readiness policy and adopt shared health query        | DFA-01, DFA-02, DFA-03, DFA-04, DFA-05, DFA-06, DFA-07, DFA-08, DFA-09, DFA-10, DFA-11, DFA-12, DFA-13, DFA-14, DFA-15, DFA-16, DFA-17, DFA-18, DFA-19, DFA-20, DFA-21, DFA-22, DFA-23, DFA-24, DFA-25, DFA-26, DFA-27, DFA-28, DFA-29, DFA-30, DFA-31, DFA-32, DFA-33, DFA-34, DFA-35, DFA-36, DFA-37, DFA-38, DFA-39, DFA-40, DFA-41, DFA-42, DFA-43, DFA-45                         |
| DFB-08 | decompose      | high   | Split machine list, detail sections and removal transaction                 | DFB-07                                                                                                                                                                                                                                                                                                                                                                                 |
| DFB-09 | perf           | medium | Isolate machine clock subscriptions from unrelated page content             | DFB-08                                                                                                                                                                                                                                                                                                                                                                                 |
| DFB-10 | decompose      | high   | Split enrollment and machine-label forms without weakening account guards   | -                                                                                                                                                                                                                                                                                                                                                                                      |
| DFB-11 | decompose      | high   | Separate Host folder browsing and provider-login lifecycle from views       | -                                                                                                                                                                                                                                                                                                                                                                                      |
| DFB-12 | decompose      | medium | Split onboarding readiness and machine content summaries                    | -                                                                                                                                                                                                                                                                                                                                                                                      |
| DFB-13 | fix            | medium | Handle home first-load failures and stale workspace replies                 | DFA-01, DFA-02, DFA-03, DFA-04, DFA-05, DFA-06, DFA-07, DFA-08, DFA-09, DFA-10, DFA-11, DFA-12, DFA-13, DFA-14, DFA-15, DFA-16, DFA-17, DFA-18, DFA-19, DFA-20, DFA-21, DFA-22, DFA-23, DFA-24, DFA-25, DFA-26, DFA-27, DFA-28, DFA-29, DFA-30, DFA-31, DFA-32, DFA-33, DFA-34, DFA-35, DFA-36, DFA-37, DFA-38, DFA-39, DFA-40, DFA-41, DFA-42, DFA-43, DFA-45                         |
| DFB-14 | decompose      | high   | Extract home local and remote submission actions                            | DFB-13                                                                                                                                                                                                                                                                                                                                                                                 |
| DFB-15 | decompose      | medium | Split home composer, dashboard and isolation controls                       | DFB-14                                                                                                                                                                                                                                                                                                                                                                                 |
| DFB-16 | decompose      | medium | Separate home model settings state and picker presentation                  | DFB-13                                                                                                                                                                                                                                                                                                                                                                                 |
| DFB-17 | decompose      | medium | Split lane board actions and ledger sections                                | -                                                                                                                                                                                                                                                                                                                                                                                      |
| DFB-18 | decompose      | medium | Split workspace search fields, controller and results rendering             | -                                                                                                                                                                                                                                                                                                                                                                                      |
| DFB-19 | decompose      | medium | Extract search navigation decisions and explicit search-store actions       | -                                                                                                                                                                                                                                                                                                                                                                                      |
| DFB-20 | decompose      | medium | Decompose explorer selection, keyboard and transfer event handling          | -                                                                                                                                                                                                                                                                                                                                                                                      |
| DFB-21 | decompose      | low    | Split explorer toolbar and recursive rows                                   | DFB-20                                                                                                                                                                                                                                                                                                                                                                                 |
| DFB-22 | decompose      | high   | Extract remote file reads and pane presentation                             | -                                                                                                                                                                                                                                                                                                                                                                                      |
| DFB-23 | decompose      | high   | Extract remote draft/save state and file action orchestration               | DFB-22                                                                                                                                                                                                                                                                                                                                                                                 |
| DFB-24 | decompose      | medium | Extract bounded remote tree building and repository read hook               | -                                                                                                                                                                                                                                                                                                                                                                                      |
| DFB-25 | decompose      | high   | Separate safe file preview selection from media renderers                   | DFB-42                                                                                                                                                                                                                                                                                                                                                                                 |
| DFB-26 | decompose      | high   | Extract changed-file revert and diff loading from rows                      | -                                                                                                                                                                                                                                                                                                                                                                                      |
| DFB-27 | decompose      | medium | Extract editor tab event wiring and context menus                           | -                                                                                                                                                                                                                                                                                                                                                                                      |
| DFB-28 | decompose      | medium | Extract Monaco model lifecycle without changing editor timing               | -                                                                                                                                                                                                                                                                                                                                                                                      |
| DFB-29 | decompose      | low    | Split fuzzy finder index/focus lifecycle and results view                   | -                                                                                                                                                                                                                                                                                                                                                                                      |
| DFB-30 | decompose      | high   | Split artifact toolbar, preview dispatch and switcher                       | -                                                                                                                                                                                                                                                                                                                                                                                      |
| DFB-31 | decompose      | medium | Extract artifact version and export lifecycle                               | DFB-30                                                                                                                                                                                                                                                                                                                                                                                 |
| DFB-32 | decompose      | high   | Separate global artifact index and stored viewer lifecycle                  | -                                                                                                                                                                                                                                                                                                                                                                                      |
| DFB-33 | decompose      | medium | Characterize and split branch picker policy/actions/views                   | DFA-01, DFA-02, DFA-03, DFA-04, DFA-05, DFA-06, DFA-07, DFA-08, DFA-09, DFA-10, DFA-11, DFA-12, DFA-13, DFA-14, DFA-15, DFA-16, DFA-17, DFA-18, DFA-19, DFA-20, DFA-21, DFA-22, DFA-23, DFA-24, DFA-25, DFA-26, DFA-27, DFA-28, DFA-29, DFA-30, DFA-31, DFA-32, DFA-33, DFA-34, DFA-35, DFA-36, DFA-37, DFA-38, DFA-39, DFA-40, DFA-41, DFA-42, DFA-43, DFA-45                         |
| DFB-34 | decompose      | medium | Split branch control menu and worktree removal guard view                   | DFA-01, DFA-02, DFA-03, DFA-04, DFA-05, DFA-06, DFA-07, DFA-08, DFA-09, DFA-10, DFA-11, DFA-12, DFA-13, DFA-14, DFA-15, DFA-16, DFA-17, DFA-18, DFA-19, DFA-20, DFA-21, DFA-22, DFA-23, DFA-24, DFA-25, DFA-26, DFA-27, DFA-28, DFA-29, DFA-30, DFA-31, DFA-32, DFA-33, DFA-34, DFA-35, DFA-36, DFA-37, DFA-38, DFA-39, DFA-40, DFA-41, DFA-42, DFA-43, DFA-45                         |
| DFB-35 | decompose      | medium | Extract guided merge state and phase views                                  | DFB-36                                                                                                                                                                                                                                                                                                                                                                                 |
| DFB-36 | fix            | medium | Handle failed or stale post-merge worktree refresh                          | DFA-01, DFA-02, DFA-03, DFA-04, DFA-05, DFA-06, DFA-07, DFA-08, DFA-09, DFA-10, DFA-11, DFA-12, DFA-13, DFA-14, DFA-15, DFA-16, DFA-17, DFA-18, DFA-19, DFA-20, DFA-21, DFA-22, DFA-23, DFA-24, DFA-25, DFA-26, DFA-27, DFA-28, DFA-29, DFA-30, DFA-31, DFA-32, DFA-33, DFA-34, DFA-35, DFA-36, DFA-37, DFA-38, DFA-39, DFA-40, DFA-41, DFA-42, DFA-43, DFA-45                         |
| DFB-37 | tests          | medium | Pin sandbox rename and workspace switching safety                           | -                                                                                                                                                                                                                                                                                                                                                                                      |
| DFB-38 | decompose      | low    | Extract workspace chip menu without altering navigation                     | DFB-37                                                                                                                                                                                                                                                                                                                                                                                 |
| DFB-39 | decompose      | high   | Extract terminal attach/replay and xterm resource lifecycle                 | -                                                                                                                                                                                                                                                                                                                                                                                      |
| DFB-40 | decompose      | high   | Split terminal overlays, paste handling and pane tabs                       | DFB-39                                                                                                                                                                                                                                                                                                                                                                                 |
| DFB-41 | fix            | medium | Adopt common routine async error presentation after decomposition           | DFB-02, DFB-03, DFB-05, DFA-01, DFA-02, DFA-03, DFA-04, DFA-05, DFA-06, DFA-07, DFA-08, DFA-09, DFA-10, DFA-11, DFA-12, DFA-13, DFA-14, DFA-15, DFA-16, DFA-17, DFA-18, DFA-19, DFA-20, DFA-21, DFA-22, DFA-23, DFA-24, DFA-25, DFA-26, DFA-27, DFA-28, DFA-29, DFA-30, DFA-31, DFA-32, DFA-33, DFA-34, DFA-35, DFA-36, DFA-37, DFA-38, DFA-39, DFA-40, DFA-41, DFA-42, DFA-43, DFA-45 |
| DFB-42 | fix            | low    | Normalize local file-action errors without losing partial failures          | -                                                                                                                                                                                                                                                                                                                                                                                      |

### desktop-e2e (26)

| Unit  | Kind      | Risk   | Title                                                             | Depends on                        |
| ----- | --------- | ------ | ----------------------------------------------------------------- | --------------------------------- |
| DE-01 | tests     | high   | Replace brittle Desktop package-boundary assertions               | -                                 |
| DE-02 | decompose | high   | Extract shared Electron launch, bounded teardown and resources    | DE-01                             |
| DE-03 | fix       | high   | Migrate smoke/startup/routines to private per-test resources      | DE-02                             |
| DE-04 | decompose | high   | Split account-control server/actions and adopt shared launch      | DE-03                             |
| DE-05 | decompose | high   | Share cwd mangling with runtime parity tests                      | DE-03                             |
| DE-06 | perf      | medium | Build Host in globalSetup and fail hidden CI flakes               | DE-04                             |
| DE-07 | fix       | high   | Surface remote listener errors as awaited test failures           | DE-06                             |
| DE-08 | decompose | high   | Extract proxy and receipt-loss controls                           | DE-07                             |
| DE-09 | decompose | high   | Extract Host seed, identity and process lifecycle                 | DE-08                             |
| DE-10 | decompose | high   | Finish remote fixture with peer and lane modules                  | DE-09                             |
| DE-11 | decompose | high   | Extract stub CLI and session state behind stable executable       | DE-05                             |
| DE-12 | decompose | high   | Split stub queries/catalogue/prompt handlers                      | DE-11                             |
| DE-13 | decompose | high   | Split default/artifact/transcript stub turns into stages          | DE-12                             |
| DE-14 | decompose | high   | Split legacy/native/parallel/workflow subagent scenarios          | DE-13                             |
| DE-15 | fix       | medium | Use exact-prefix scenario registry instead of incidental keywords | DE-14, DE-10                      |
| DE-16 | lint      | medium | Finish CJS typed boundaries and lint/checkJs closure              | DE-15                             |
| DE-17 | decompose | medium | Move composer/shell clusters with title-multiset gate             | DE-16                             |
| DE-18 | decompose | medium | Move files/terminal/settings/skills/artifacts clusters            | DE-17                             |
| DE-19 | decompose | medium | Move session/transcript/subagent clusters and retire smoke        | DE-18                             |
| DE-20 | tests     | medium | Replace fixed sleeps with progress and bounded stability          | DE-19                             |
| DE-21 | tests     | low    | Use real theme preferences and semantic selectors                 | DE-20                             |
| DE-22 | tests     | high   | Cover bookmark, branch jump and clone UI/file flows               | DE-19                             |
| DE-23 | tests     | high   | Cover guided worktree finish and safe refusals                    | DE-19                             |
| DE-24 | tests     | medium | Cover skill bundle import/export through dialog boundary          | DE-19                             |
| DE-25 | tests     | high   | Cover Claude account routing without real credentials             | DE-19                             |
| DE-26 | docs      | low    | Rewrite e2e skill for shared fixtures and verified commands       | DE-21, DE-22, DE-23, DE-24, DE-25 |

### reloc (2)

| Unit  | Kind    | Risk | Title                                                                             | Depends on |
| ----- | ------- | ---- | --------------------------------------------------------------------------------- | ---------- |
| RL-02 | tooling | high | Implement AST specifier rewriting, alias canonicalization and resumable git moves | -          |
| RL-03 | tooling | high | Execute one frozen-window mechanical migration and resolve audited path math      | RL-02      |

### cleanup (5)

| Unit  | Kind      | Risk   | Title                                                                       | Depends on                                                                                                                              |
| ----- | --------- | ------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| CL-01 | tooling   | high   | Remove obsolete shared alias compatibility only after all consumers migrate | TL-05, TL-06, TL-11, libs, desktop-main, desktop-chat, desktop-core, desktop-features, desktop-e2e, host, control, site, tooling        |
| CL-02 | tooling   | medium | Retire old unit-test globs and redundant cross-library TS includes          | CL-01                                                                                                                                   |
| CL-03 | lint      | medium | Promote reviewed warning policies to errors                                 | CL-02                                                                                                                                   |
| CL-04 | tooling   | medium | Require final hard budgets, gate evidence and accurate conventions          | CL-03, TL-03, TL-10, TL-14, libs, desktop-main, desktop-chat, desktop-core, desktop-features, desktop-e2e, host, control, site, tooling |
| CL-05 | dead-code | low    | Collapse internal-only re-export chains (shared -> runtime -> desktop)      | CL-01                                                                                                                                   |
