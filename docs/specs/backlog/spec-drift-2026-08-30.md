# Spec drift audit — every living contract vs. the code

Written 2026-08-30. Scope: all 14 files in [`docs/`](../../), plus
the open boxes in [`TRACKER.md`](../TRACKER.md) and the status columns in the
other three `backlog/` files. Method: read each doc in full, then verify every
claim it makes about a file name, a count, or a behaviour against the code.

**Why this file exists.** `reference/` is the folder the repo tells you to
trust, and the rule is that the code disagreeing with it makes _the doc_ wrong.
That rule has not been enforced in a while: 44 claims across 9 of the 14 docs
describe a Phosphor that no longer exists — layouts never built, tools with
different signatures, tabs that were added and never written down. Two docs
(`style-guide.md`, `mcp.md`) verified clean end to end, and `worktrees.md` and
`updates.md` verified clean apart from nothing.

Every row below is `open` unless it says otherwise. Fix a row in the same PR
that fixes the doc, and delete this file when it reaches zero.

## How to read the severity column

- **wrong** — the doc states something the code contradicts. A reader acting on
  it is misled.
- **missing** — the code has a real surface the doc never mentions. Less
  dangerous, still drift.
- **stale** — was true, has been overtaken (usually a shipped item still listed
  as to-build).

---

## reference/overview.md · reference/architecture.md

| #   | Doc line              | Says                                                                         | Code does                                                                                                                                                                                              | Sev   | Status |
| --- | --------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ------ |
| A1  | overview.md:22        | "no approval dialogs, no confirmation gates on tool calls. Do not build any" | a command-approval sheet with risk analysis ships (`src/features/extension-ui/CommandApprovalSheet.tsx:28`). It is extension-initiated, so the non-negotiable arguably holds — but the doc must say so | wrong | open   |
| A2  | architecture.md:42    | "13 prefixes today"                                                          | 15. `artifacts:*` and `claude:*` are absent from the list (`shared/ipc.ts:96`)                                                                                                                         | wrong | open   |
| A3  | architecture.md:26-31 | process diagram names `WorkspaceManager`, `SessionManager`, `FsService`      | none exist. The units are `SessionRegistry` (`electron/registry.ts`), `PtyManager`, `PiRpcClient`                                                                                                      | wrong | open   |
| A4  | architecture.md:49    | "2 of 5 pi extensions"                                                       | `pi-ext/` holds 6 (5 bundled + `orchestrator.ts`)                                                                                                                                                      | wrong | open   |
| A5  | architecture.md:57    | layout persists in electron-store                                            | `AppPrefs` has no layout field; pane sizes go to localStorage via `autoSaveId` (`src/app/App.tsx:217`), pane selection is not persisted at all (`src/stores/layout.ts:21`)                             | wrong | open   |

## reference/pi-integration.md

| #   | Doc line | Says                                                  | Code does                                                                                                 | Sev     | Status |
| --- | -------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------- | ------ |
| P1  | 18       | `-e` "loads the bundled Phosphor artifacts extension" | five extensions are bundled into every session (`electron/ipc/pi-session-handlers.ts:49-57`)              | wrong   | open   |
| P2  | 23-45    | table titled "RPC commands (complete set)"            | omits `clear_queue`, `get_entries`, `get_tree`, `get_available_thinking_levels` (`shared/rpc.ts:357-362`) | missing | open   |
| P3  | 49       | event list                                            | omits `agent_settled`, `bash_execution_update`, and the three `summarization_retry_*` events              | missing | open   |

## reference/ui-shell.md

The most-drifted doc in the folder. It describes a four-pane layout that was
never built.

| #   | Doc line | Says                                                                               | Code does                                                                                                                                                                | Sev   | Status |
| --- | -------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ------ |
| U1  | 26-36    | chat 45% / files 35% / terminal 20% bottom strip; artifacts joins the files region | chat plus **one** mutually-exclusive right pane (`files \| changes \| terminal \| artifacts`), keyed per session. Terminal is a right pane (`src/stores/layout.ts:5-31`) | wrong | open   |
| U2  | 26       | layout "persisted per-workspace in app prefs"                                      | localStorage; selection not persisted (see A5)                                                                                                                           | wrong | open   |
| U3  | 26       | panes reopen "from a view menu"                                                    | no view menu. TopBar switches, palette, shortcuts (`src/app/useGlobalShortcuts.ts:141-150`)                                                                              | wrong | open   |
| U4  | 29       | files pane supports "open to the side"                                             | not implemented (`src/features/files/FilesPane.tsx:31-39`)                                                                                                               | wrong | open   |
| U5  | 35       | double-click a handle resets the split                                             | no double-click handler on any `PanelResizeHandle`                                                                                                                       | wrong | open   |
| U6  | 47       | a status strip renders `setStatus` entries, crash notices, update availability     | no such component. `setStatus` is consumed by the context meter and the MCP surfaces                                                                                     | wrong | open   |
| U7  | 6        | window title is `workspace · session name`                                         | workspace only (`src/app/App.tsx:107-113`) — and the code comment there repeats the doc's claim, so fix both                                                             | wrong | open   |
| U8  | 7        | ⌘N creates a session                                                               | opens the home screen, `activate(null)` (`useGlobalShortcuts.ts:129-132`). ⌘⇧E, ⌘⇧G, ⌘±0, ⌃O are undocumented                                                            | wrong | open   |
| U9  | 18       | New Session button is labelled `+ New`                                             | "New session" (`src/features/sessions/Sidebar.tsx:538`)                                                                                                                  | wrong | open   |

## reference/settings.md

| #   | Doc line | Says                                                                              | Code does                                                                                                                                                            | Sev     | Status |
| --- | -------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------ |
| S1  | 3        | a Settings **window** with 7 tabs                                                 | a modal with 14. Undocumented: `orchestration`, `accounts`, `extensions`, `claude-provider`, `web-access`, `about` (`src/features/settings/settingsUiStore.ts:3-17`) | wrong   | open   |
| S2  | 12       | default model/provider offer choices from `get_available_models` or `models.json` | both are free-text inputs with placeholders (`tabs/AgentTab.tsx:147-158`)                                                                                            | wrong   | open   |
| S3  | 20       | Workspaces tab does remove, reorder, clear                                        | remove and reset-layout only (`tabs/WorkspacesTab.tsx:15-79`)                                                                                                        | wrong   | open   |
| S4  | 25       | Advanced viewer covers skills/extensions/prompts                                  | also `themes` (`tabs/AdvancedTab.tsx:59`)                                                                                                                            | missing | open   |

## reference/chat.md

| #   | Doc line | Says                                                                    | Code does                                                                                                                                                                   | Sev   | Status |
| --- | -------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ |
| C1  | 15       | native commands "new, fork, clone, compact, export, model, name, tree…" | three: `compact`, `export`, `name` (`src/features/chat/Composer.tsx:142-160`)                                                                                               | wrong | open   |
| C2  | 28       | code blocks offer "open as file"                                        | no such action. Open-as-artifact, run-in-terminal (shell only), copy (`src/components/markdown/CodeBlock.tsx:83-113`)                                                       | wrong | open   |
| C3  | 29       | user messages offer "fork from here" and edit-and-refork                | the action is **Rewind to here**: it uses the `fork` RPC but truncates in place and creates no new session (`src/features/chat/rewind.ts:5-25`)                             | wrong | open   |
| C4  | 77       | code blocks show line numbers on hover                                  | never implemented (`CodeBlock.tsx:116-127`)                                                                                                                                 | wrong | open   |
| C5  | 78       | mermaid blocks export PNG/SVG                                           | zoom-lightbox and a code fallback only (`MermaidBlock.tsx:80-95`)                                                                                                           | wrong | open   |
| C6  | 82       | html preview is "inlined content only"                                  | deliberately the opposite — served over `phosphor-artifact://` because `srcdoc` inherits the app CSP and makes `allow-scripts` a no-op (`src/components/SandboxedHtml.tsx`) | wrong | open   |
| C7  | 88       | thinking levels run off→xhigh                                           | seven levels; `max` is omitted (`shared/rpc.ts:66`)                                                                                                                         | wrong | open   |

## reference/terminal.md

| #   | Doc line | Says                                    | Code does                                                                                                                                      | Sev   | Status |
| --- | -------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ |
| T1  | 5        | PTY cwd is the workspace root           | the owning session's cwd — the worktree for worktree sessions, which line 20 of the same doc states correctly (`src/stores/terminal.ts:16-19`) | wrong | open   |
| T2  | 15       | scrollback is configurable, default 10k | hardcoded `10_000`, no setting reads it (`TerminalView.tsx:59`)                                                                                | wrong | open   |
| T3  | 26       | "run in terminal" never auto-executes   | true for chat code blocks; `RunCommandRow.tsx:31-33` passes `{ execute: true }`                                                                | wrong | open   |

## reference/extensions.md

| #   | Doc line | Says                                                                  | Code does                                                                                                                                          | Sev     | Status |
| --- | -------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------ |
| E1  | 296      | "Three keys are load-bearing today"                                   | four. `claude-subagents` is structured, parsed and rendered (`src/features/chat/subagentStatus.ts:20`) — and line 400 of the same doc describes it | wrong   | open   |
| E2  | 97       | the MCP settings tab is a per-extension tab gated on `pi-mcp-adapter` | MCP is top-level and always shown; `EXTENSION_TABS` holds only `claude-provider` and `web-access` (`SettingsModal.tsx:27,39-42`)                   | wrong   | open   |
| E3  | 45       | "the catalogue pins reviewed versions"                                | no entry pins a version; all four specs are bare, so every install takes latest (`src/features/settings/catalogue.ts:21-42`)                       | wrong   | open   |
| E4  | 177      | `JobOutput` is exported from `tabs/ExtensionsTab.tsx`                 | its own module, imported by three tabs (`src/features/settings/JobOutput.tsx:9`)                                                                   | wrong   | open   |
| E5  | 172-173  | packages IPC list                                                     | omits `packages:checkUpdates`, which backs the documented "Update all"                                                                             | missing | open   |

Not a spec bug but adjacent: **`CLAUDE.md` is the file that is wrong on the
extension count** ("ships seven … the bundled six"). It is six files, five
bundled. `specs/README.md:40` and the `extensions.md` table are both right.

## reference/cli-providers.md

| #   | Doc line | Says                                                                                                | Code does                                                                                                   | Sev   | Status |
| --- | -------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----- | ------ |
| L1  | 435-440  | Phase C ("drive `/login` from a settings panel, show which account is signed in") is still to build | shipped as Settings → Accounts (`tabs/AccountsTab.tsx:16-55`, `electron/pi/login-flow.ts`, `pi:startLogin`) | stale | open   |
| L2  | 104      | "Verified against `@saccolabs/pi-claude-cli` 0.4.6"                                                 | the repo's own floor is `>= 0.4.16` (below it the system prompt never reaches the model at all)             | stale | open   |

## reference/orchestration.md

All 14 fixed in the same PR that raised them. The tool table is now enforced
by `pi-ext/orchestrator-doc.test.ts`, which reads the doc and fails when a
tool's arguments stop matching the schema the extension registers — five of
the ten rows were wrong when the guard was written.

| #   | Doc line | Says                                                                             | Code does                                                                                                                                                                                                           | Sev     | Status |
| --- | -------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------ |
| O1  | 242      | `git_status` takes `sessionId \| path`                                           | one required `workspacePath` string (`electron/orchestrator/bridge.ts:365-371`)                                                                                                                                     | wrong   | open   |
| O2  | 236      | `fleet_status` takes no args                                                     | a required `scope` (`all\|blocked\|idle`), added so the args object is non-empty on the Claude provider (`bridge.ts:268-276`)                                                                                       | wrong   | open   |
| O3  | 244      | `memory_read` takes no args                                                      | a required `purpose` string the host ignores (`pi-ext/orchestrator.ts:262-276`)                                                                                                                                     | wrong   | open   |
| O4  | 239      | `session_send` mode is `steer\|followUp`                                         | a third value `prompt`; both others fall back to it when the target is not streaming (`bridge.ts:299-313`)                                                                                                          | wrong   | open   |
| O5  | 246      | `publish_digest` takes a `DigestPayload`                                         | no such type. The bridge parses `headline` + `items` (tolerating a JSON-string `items`) and only ever synthesizes `action.kind = 'start'` — the other four `DigestItem.action` kinds are dead (`bridge.ts:175-217`) | wrong   | open   |
| O6  | 77-95    | the `FleetSession` shape                                                         | omits `projectRoot`, the field that groups worktree sessions under their project — which the doc's own manual test 7 depends on (`shared/models.ts:337-346`)                                                        | missing | open   |
| O7  | 261      | sweep kinds include `question`                                                   | `SweepKind` is `'brief' \| 'review'`; no `question` branch in the prompt builder                                                                                                                                    | wrong   | open   |
| O8  | 263      | "(opt-in) once when a workspace opens" is a sweep trigger                        | no such trigger or setting exists, and line 360 of the same doc contradicts it (`electron/orchestrator/manager.ts:190-200`)                                                                                         | wrong   | open   |
| O9  | 524      | manual test 12 expects a "brief-on-open off" control in Settings → Orchestration | the tab has mode, model, `maxConcurrent`, notification-mute (`tabs/OrchestrationTab.tsx:97-180`)                                                                                                                    | wrong   | open   |
| O10 | 398      | `isOrchestratorSession()` gates `workspaceStats()`                               | no such function; home tiles come from `sessions:stats`, and the exclusion happens in the scanner (`electron/pi/session-scanner.ts:208`)                                                                            | wrong   | open   |
| O11 | 477      | code map names `src/features/orchestrator/OrchestratorRow.tsx`                   | does not exist. It is `OrchestratorHeaderButton.tsx` (+ `OrchestratorModePicker.tsx`, `threadHealth.ts`)                                                                                                            | wrong   | open   |
| O12 | 505      | manual test 5 expects "one Orchestrator row above its sessions"                  | a group-header button, never a row — as the doc's own Differentiation section says                                                                                                                                  | wrong   | open   |
| O13 | 517      | manual test 8 says "click the sidebar spark"                                     | it renders `OrchestratorIcon`; line 431 explicitly says it is not a spark                                                                                                                                           | wrong   | open   |
| O14 | 478      | the IPC row                                                                      | omits `orchestrator:reset`, `orchestrator:restart` (both treated as shipped at 611-613) and the `fleet:changed` push channel                                                                                        | missing | open   |

Verified accurate and worth keeping: the three modes and their capability
matrix, call-time enforcement through `BridgeDeps.modeFor` (`bridge.ts:50-58`),
the sentinel control channel and its 20s timeout, the prefs defaults and the
`orchestratorModeOf` migration, all ten tool names, and the fleet reducer's
160-char `lastLine` and 50-path caps.

---

## Status corrections elsewhere

These are not `reference/` drift — they are status fields in the tracking files
that no longer match the code. Corrected in this PR where the fix is one line;
the rest are rows to work.

| #   | File                                               | Was                                 | Reality                                                                                                                                                                                                                                                                                                                          | Status                |
| --- | -------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| X1  | TRACKER.md P11 B6                                  | open                                | **partly shipped**. The all-zero `ModelCost` case renders a "no pricing configured" affordance instead of a misleading `$0.0000` (`composer/pricing.ts:9`, `ContextMeter.tsx:137-158`). The per-component cost rows never shipped — the popover has one `Cost` row and four _token_ rows                                         | open (narrow the box) |
| X2  | TRACKER.md P11 phase 2                             | "delivered differently, unverified" | **shipped, verified**: nine steps in `@theme`, one arbitrary `text-[…]` left in `src/`                                                                                                                                                                                                                                           | tick it               |
| X3  | TRACKER.md P11 phase 3                             | "likely delivered, unverified"      | **shipped**: `items/ActivityGroup.tsx` + `transcriptRows.ts`                                                                                                                                                                                                                                                                     | tick it               |
| X4  | TRACKER.md P11 phase 4                             | never built                         | **confirmed open**: two independent hover implementations, no `MessageActions` symbol in `src/` (`MessageItem.tsx:177,257`)                                                                                                                                                                                                      | open                  |
| X5  | TRACKER.md P11 phase 5                             | open                                | **confirmed open**, and worse than recorded: `RetryStrip.tsx`, `banners.tsx` _and_ `composer/RateLimitBanner.tsx` are three separate implementations, not two                                                                                                                                                                    | open                  |
| X6  | perf-findings.md F16                               | open                                | **moot as written**. `pi:listLiveSessions` — the dead surface the finding calls "also the fix" — does not exist anywhere; it was deleted in `4c02e13` (#79), the very commit the row claims to have been re-verified against. The renderer-reload leak may still be real, but the row must be rewritten before anyone acts on it | open (rewrite)        |
| X7  | perf-findings.md F1-F4, F6, F9, F12, F13, F17, F18 | open                                | **all confirmed still open**, unchanged. 11 of 17 open findings re-verified                                                                                                                                                                                                                                                      | no change             |
| X8  | cleanup-plan.md phase 4 loose end                  | open                                | **fixed**: `rewind.ts:34-38` carries the "Deliberately NOT `piCall`" rationale the row asked for                                                                                                                                                                                                                                 | fixed                 |
| X9  | cleanup-plan.md phase 6                            | open                                | **confirmed open**: all five symbols still exported, still single-file                                                                                                                                                                                                                                                           | no change             |
| X10 | backlog/README.md connectors row                   | "6 of 7 findings" open              | **1 of 7**. Only F4 (pi RPC has no dialog cancel, upstream) is open                                                                                                                                                                                                                                                              | fixed here            |
| X11 | connectors.md:4                                    | "Nothing here has shipped"          | all four build phases are marked Done further down the same file                                                                                                                                                                                                                                                                 | fixed here            |

## What this says about the process

The repo already has the right rule — _"if the change makes a `reference/` file
wrong, that file is part of the same diff, not a follow-up"_. Every row above
is an instance of it not being followed. Two patterns account for most of them:

1. **Aspirational text was never demoted.** `ui-shell.md` and `chat.md` still
   read like the build plan they were promoted from. Nine of their sixteen rows
   describe features nobody ever built, not features that changed.
2. **Signatures drift silently.** The orchestrator's ten tools have no
   compile-time link to the doc that describes them, unlike `shared/rpc.ts`,
   which has drift guards and is the one integration doc that verified clean.
   If any single fix is worth more than the rest, it is generating the tool
   table in `orchestration.md` from `bridge.ts` — or asserting it in a test.
