# Known issues

**Defects that reproduce today.** Every row was re-verified against the code on
2026-09-09 by reading the cited source, not by trusting an earlier pass. This is
the one file here that describes what is _wrong_ rather than how something
works; everything else in `docs/` is a living contract.

A row leaves this file when the code changes, in the same diff. If you fix
something here, delete its row — the code becomes the record.

## Streaming and memory

The hot path is pi → main → renderer. These were measured with benchmarks
against real session files; the numbers are from that audit and the code paths
are unchanged.

| #   | Issue                                                                                                       | Where                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| S1  | PTY scrollback re-copies the whole 256 KB cap on **every** data chunk (938 ms vs 1.3 ms per 10k chunks)     | `electron/pty/pty-manager.ts` — `session.scrollback + data`, then slice   |
| S2  | The whole `tools` record is cloned on every tool-args/output delta (288 µs/event at 1600 tools)             | `src/features/chat/reducer.ts`, `toolIdentity.ts` `withExecutionIdentity` |
| S3  | `buildTranscriptRows` rebuilds the entire transcript per token, defeating `memo` on every visible row       | `src/features/chat/MessageList.tsx` — `useMemo(..., [items])`             |
| S4  | `summarizeTool` re-`JSON.parse`s the accumulated args on every delta — O(n²), 665 ms for one 488 KB `write` | `src/features/chat/tools/toolSummaries.ts` — `tryParseArgs`               |
| S5  | `JsonlDecoder` is O(n²) when one record spans many stdout chunks (959 ms for a 15.3 MB record)              | `electron/pi/jsonl.ts` — `buffer += chunk`, `indexOf`, `slice`            |
| S6  | `message_end` fold is O(items + tools), and pi emits one message per tool call ⇒ O(n²) per session          | `src/features/chat/toolIdentity.ts`, `messageContent.ts`                  |
| S7  | `FilesChangedPane` re-derives every touched file (re-parsing every patch) on every tool delta               | `src/features/files/FilesChangedPane.tsx` — depends on `tools` (S2)       |
| S8  | Artifact `versions[]` grows unbounded with full content per version, duplicated on the tool payload         | `src/stores/artifacts.ts`                                                 |
| S9  | `ArtifactsPane` runs `clearUnseen` (a `set`) on every render — no dep array                                 | `src/features/artifacts/ArtifactsPane.tsx`                                |

Two more that are worth reading in full because their history is misleading:

- **S10 — `releaseWorkspace` is never called.** It is the documented fix for
  editor/Monaco retention, it exists in `src/stores/files.ts`, and its only
  callers anywhere are its own tests. `disposeSession` does not call it.
- **S11 — live pi subprocesses are unbounded.** ~172 MB RSS for one _idle_ pi
  tree, and nothing reclaims them. This was genuinely fixed once by an
  idle-session reaper, and then the reaper was deleted wholesale with the
  orchestration removal on 2026-09-03. Today the only `suspendSession` caller
  is the sidebar menu, and every `disposeSession` caller is user-driven. Treat
  "there is no cross-session manager" (CLAUDE.md fact 5) as deliberate and this
  as the cost of it.

**S12 — `git:info` is uncached**: four `git` spawns per debounced `fs:changed`,
18 ms median on this repo, called from `BranchControl` on every file change.
The TTL cache plus in-flight dedupe in `electron/fs/git-info.ts` is on
`gitInfoBatch`, the **sibling** function. This was filed as fixed for thirteen
days because a status note credited the wrong function — check which one you
are looking at before concluding it is handled.

**S13 — the captured reducer/e2e fixture uses the pre-0.84.0 wire shape.**
`src/features/chat/__fixtures__/real-session-events.jsonl` carries `message`
and `assistantMessageEvent.partial` on all 193 `message_update` records and no
top-level `usage`; `partial` alone is 42.8% of its bytes. `e2e/fixtures/pi-stub.cjs`
emits the same dead shape. So no test exercises what pi actually sends now.

## Windows

pi itself is reached correctly on Windows — `electron/pi/win-launch.ts` reads
npm's `.cmd` shim through to `node.exe` + `cli.js`, and every pi spawn goes
through `PiHealth.prefixArgs`. The remaining gaps are the CLIs Phosphor runs
_directly_, found through `resolveBinary` in `electron/pi/packages.ts`, which
still returns a single path.

| #   | Issue                                                                                                                                                                                                        | Where                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| W1  | An npm-installed Claude Code (`claude.cmd`) cannot be spawned for usage polling, status or sign-in; `spawn EINVAL`. The native `claude.exe` install is fine, and sessions are unaffected (pi spawns the CLI) | `electron/pi/packages.ts` `resolveBinary` → `electron/claude/usage.ts`, `claude-login.ts` |
| W2  | Terminal busy detection is off (`isBusy` reads a POSIX process title); the tab count never shows a busy badge                                                                                                | `electron/pty/pty-manager.ts` — `process.platform !== 'win32' &&`                         |
| W3  | Lane disk sizes report "unknown" (`du` has no Windows equivalent wired in)                                                                                                                                   | `electron/maintenance/sweep.ts`                                                           |
| W4  | The installer is unsigned: SmartScreen shows "unknown publisher" on first install until `WIN_CERT_PFX` is configured in the release workflow                                                                 | `.github/workflows/release-continuous.yml`                                                |

## Losing an in-flight turn

**pi persists a turn only when the turn ends**, so any exit during a turn
discards all of it — with no warning before and no trace after. The session is
then indistinguishable from one the model never answered.

| #   | Issue                                                                                                  | Where                                                       |
| --- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| T1  | `updates:restartAndInstall` quits with zero checks on session state, from two UI entry points          | `electron/ipc/updates-handlers.ts`, `updater.ts`            |
| T2  | `before-quit` has no in-flight check either, so Cmd+Q and window-close lose turns the same way         | `electron/main.ts` — straight to `registry.disposeAll()`    |
| T3  | No confirmation before the quit and no interruption marker after it                                    | nothing exists in `electron/` or `src/`                     |
| T4  | The "pi owns its session files and gets a SIGTERM to flush" comment is **wrong** for an in-flight turn | `electron/main.ts` and now also `electron/pi/rpc-client.ts` |

**Before planning this: the obvious signal no longer exists.** The original
plan was built on `FleetHub`/`FleetPhase`, which were deleted with the
orchestration removal. `SessionRegistry` tracks only
`{sessionId, workspacePath, client}` — no phase, no streaming state. In-flight
state has to be derived fresh, most likely from the pi event stream in
`electron/ipc/pi-session-handlers.ts`, which already sees `agent_start` and
`agent_end`.

## Tool and MCP row rendering

The bash half of this was fixed — rows are now labelled by their operative
line rather than their `cd` preamble. The MCP half is untouched, and F1/F2/F3
below are one lane: nothing in `src/features/chat/` reads an MCP gateway
call's mode.

| #   | Issue                                                                                                    | Where                                                                       |
| --- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| M1  | Every MCP gateway call renders as `Used mcp`, whichever of its nine modes ran                            | `src/features/chat/tools/toolSummaries.ts` — `default:` branch              |
| M2  | Raw `mcp__server__tool` names leak into the label                                                        | same file, claude-cli default branch                                        |
| M3  | `ToolSearch` rows show the machine query (`select:…`, `mcp__custom-tools__…`) instead of the intent      | same file                                                                   |
| M4  | A failed tool hides its arguments two clicks deep — `isError` never seeds the expanded state             | `src/features/chat/tools/toolDetails.tsx`                                   |
| M5  | The adapter's prose MCP status renders next to the structured chip, because its key is not in the filter | `src/features/extension-ui/ExtensionUiHosts.tsx` — `STRUCTURED_STATUS_KEYS` |

**M2 is pinned by a test.** `src/features/chat/items/claudeCliRendering.test.ts`
asserts the raw `mcp__linear__save_issue` string reaches the label. Changing
the behaviour means changing that assertion — decide the intent first rather
than treating the test as an accident.

## Trust and recovery

Found in a 2026-09-05 workbench review; all still reproduce.

| #   | Issue                                                                                                                    | Where                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| R1  | A conflicting PR still classifies as ready/merge, and a PR with no CI reads "checks green"                               | `src/features/home/laneState.ts`                            |
| R2  | The lane board's "Merge" is a local `--no-ff` merge, not a PR merge, and nothing in the label says so                    | `src/features/home/LaneBoard.tsx`, `MergeWorktreeModal.tsx` |
| R3  | The Changes inventory is tool-call-only: every write is marked created, and counts accumulate rather than reflect        | `src/features/files/collectTouchedFiles.ts`                 |
| R4  | Restore trashes a file when the baseline lookup **errors**, because `showFileAt` returns `null` for any failure          | `electron/fs/git-service.ts`                                |
| R5  | A failed worktree creation silently starts the session in the original checkout — no retry, no cancel                    | `src/features/sessions/startChat.ts`                        |
| R6  | A dirty lane with no PR classifies as idle; "Needs a push" also absorbs "changes requested" and "N checks failing"       | `src/features/home/laneState.ts`                            |
| R7  | The model picked on Home is written to the drafts store and never passed into `createSession`                            | `WorkspaceHome.tsx` → `startChat.ts`                        |
| R8  | Cmd+K lists only the first eight sessions from the current cwd                                                           | `src/features/palette/CommandPalette.tsx`                   |
| R9  | Home stats cover one cwd while the Ledger beside them is project-wide; a `gh` failure is indistinguishable from "no PRs" | `WorkspaceHome.tsx`, `src/stores/pullRequests.ts`           |
| R10 | "Resume session" disposes before it looks the session up, so it silently starts a fresh one                              | `src/features/chat/banners.tsx`                             |

**R11 — modals are not dialogs.** `src/components/Modal.tsx` has no
`role="dialog"`, no `aria-modal`, no focus trap and no focus restoration, and
the Settings close button has no accessible name. `src/lib/shortcutContext.ts`
says outright that its data marker exists "without pretending to add a focus
trap". The Changes pane was fixed; this was not.

**R12 — tertiary ink fails contrast**: 2.74:1 on light and 3.77:1 on dark,
against a 4.5:1 bar for normal text (`src/styles/index.css`). Individual copy
has been migrated to secondary ink, but the tokens themselves are unchanged.

## Code health

| #   | Issue                                                                                                        | Where                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| H1  | `errorText` (`shared/errors.ts`) is not enforced; 18 hand-rolled `err instanceof Error ? …` sites regressed  | across `src/features/settings/`, `electron/pi/`                                     |
| H2  | `ChatImage.tsx` does `(error as Error).message` on an `unknown` — a thrown string renders an empty failure   | `src/features/chat/ChatImage.tsx`                                                   |
| H3  | One raw `piCommand` site carries no exemption comment, so nobody can tell if it is deliberate (CLAUDE.md #3) | `src/features/chat/composer/queueActions.ts`                                        |
| H4  | `useAsyncAction` is not adopted by `MessageItem`, `ForkPickerModal`, `TreeViewModal`                         | those three files                                                                   |
| H5  | Five symbols are exported but used in exactly one file                                                       | `agent-settings.ts`, `useGlobalShortcuts.ts`, `CommandPalette.tsx`, `shared/mcp.ts` |
| H6  | Three separate banner implementations that a single `Notice` primitive would replace                         | `RetryStrip.tsx`, `banners.tsx`, `composer/RateLimitBanner.tsx`                     |
| H7  | Two hover-action implementations in one file                                                                 | `src/features/chat/MessageItem.tsx`                                                 |
| H8  | Per-component cost rows are still missing from the usage popover                                             | `src/features/chat/composer/` — `ContextMeter`                                      |

H1 would hold better as an ESLint rule than as another conversion pass. H2 is
the only correctness bug in this section; fix it first.
