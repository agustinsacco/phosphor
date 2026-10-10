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

| #   | Issue                                                                                                       | Where                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| S2  | The whole `tools` record is cloned on every tool-args/output delta (288 µs/event at 1600 tools)             | `apps/desktop/src/features/chat/reducer.ts`, `toolIdentity.ts` `withExecutionIdentity` |
| S3  | `buildTranscriptRows` rebuilds the entire transcript per token, defeating `memo` on every visible row       | `apps/desktop/src/features/chat/MessageList.tsx` — `useMemo(..., [items])`             |
| S4  | `summarizeTool` re-`JSON.parse`s the accumulated args on every delta — O(n²), 665 ms for one 488 KB `write` | `apps/desktop/src/features/chat/tools/toolSummaries.ts` — `tryParseArgs`               |
| S6  | `message_end` fold is O(items + tools), and pi emits one message per tool call ⇒ O(n²) per session          | `apps/desktop/src/features/chat/toolIdentity.ts`, `messageContent.ts`                  |
| S7  | `FilesChangedPane` re-derives every touched file (re-parsing every patch) on every tool delta               | `apps/desktop/src/features/files/FilesChangedPane.tsx` — depends on `tools` (S2)       |
| S8  | Artifact `versions[]` grows unbounded with full content per version, duplicated on the tool payload         | `apps/desktop/src/stores/artifacts.ts`                                                 |
| S9  | `ArtifactsPane` runs `clearUnseen` (a `set`) on every render — no dep array                                 | `apps/desktop/src/features/artifacts/ArtifactsPane.tsx`                                |

Two more that are worth reading in full because their history is misleading:

- **S10 — `releaseWorkspace` is never called.** It is the documented fix for
  editor/Monaco retention, it exists in `apps/desktop/src/stores/files.ts`, and its only
  callers anywhere are its own tests. `disposeSession` does not call it.
- **S11 — live pi subprocesses are unbounded.** ~172 MB RSS for one _idle_ pi
  tree, and nothing reclaims them. This was genuinely fixed once by an
  idle-session reaper, and then the reaper was deleted wholesale with the
  orchestration removal on 2026-09-03. Today the only `suspendSession` caller
  is the sidebar menu, and every `disposeSession` caller is user-driven. Treat
  "there is no cross-session manager" (CLAUDE.md fact 5) as deliberate and this
  as the cost of it.

**S13 — the captured reducer/e2e fixture uses the pre-0.84.0 wire shape.**
`apps/desktop/src/features/chat/__fixtures__/real-session-events.jsonl` carries `message`
and `assistantMessageEvent.partial` on all 193 `message_update` records and no
top-level `usage`; `partial` alone is 42.8% of its bytes. `apps/desktop/e2e/fixtures/pi-stub.cjs`
emits the same dead shape. So no test exercises what pi actually sends now.

## Windows

pi itself is reached correctly on Windows — `apps/desktop/electron/pi/win-launch.ts` reads
npm's `.cmd` shim through to `node.exe` + `cli.js`, and every pi spawn goes
through `PiHealth.prefixArgs`. The remaining gaps are the CLIs Phosphor runs
_directly_, found through `resolveBinary` in `apps/desktop/electron/pi/packages.ts`, which
still returns a single path.

| #   | Issue                                                                                                                                                                                                        | Where                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| W1  | An npm-installed Claude Code (`claude.cmd`) cannot be spawned for usage polling, status or sign-in; `spawn EINVAL`. The native `claude.exe` install is fine, and sessions are unaffected (pi spawns the CLI) | `apps/desktop/electron/pi/packages.ts` `resolveBinary` → `apps/desktop/electron/claude/usage.ts`, `claude-login.ts` |
| W2  | Terminal busy detection is off (`isBusy` reads a POSIX process title); the tab count never shows a busy badge                                                                                                | `apps/desktop/electron/pty/pty-manager.ts` — `process.platform !== 'win32' &&`                                      |
| W3  | Lane disk sizes report "unknown" (`du` has no Windows equivalent wired in)                                                                                                                                   | `apps/desktop/electron/maintenance/sweep.ts`                                                                        |
| W4  | The installer is unsigned: SmartScreen shows "unknown publisher" on first install until `WIN_CERT_PFX` is configured in the release workflow                                                                 | `.github/workflows/release-continuous.yml`                                                                          |

## Losing an in-flight turn

**T3: no interruption recovery marker.** Pi persists a turn only when it ends.
Quit and update restart now confirm active or unconfirmed work before teardown,
but an explicitly stopped turn, OS termination, or crash can still leave no
recoverable transcript for that turn. Main has activity facts and abort logs,
not a durable interruption journal. Editor save/discard prompts and a
wait-until-finished quit action are also still missing. See [updates.md](updates.md).

## Context budget and compaction

Found on 2026-10-10 by replaying the compactions in twelve lanes' session
files. Every one of them is upstream of Phosphor (in pi or pi-claude-cli). The
budget rule itself holds: native sessions compact at pi's own threshold when
the model window is below the budget, Claude sessions at `budget − reserve`
(383,616 for 400k), mid-run between tool cycles, and the next request always
continued.

| #   | Issue                                                                                                                                                                                                                                                                                                                         | Where                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| C1  | A Claude session under-counts its context by the last response's output. The provider reports `usage.totalTokens` without output; pi's Anthropic provider includes it, and pi's threshold check trusts that field. A 20-53k thinking response let requests through at 401k and 415k on a 400k budget, and the meter reads low | pi-claude-cli `src/event-bridge.ts` `recomputeUsage`                                       |
| C2  | Compaction runs at the session's thinking level, and the Claude provider never sends pi's summary cap (`maxTokens`, 0.8 × reserve). At `max`, a Claude compaction wrote 46-72k output tokens and blocked the session for 6-10 minutes                                                                                         | pi `agent-session.js` (`compact(…, this.thinkingLevel)`); pi-claude-cli `src/provider.ts`  |
| C3  | Chained summaries only grow and drift. pi's update prompt preserves everything, and appends cumulative read/modified file lists it never prunes. Over 17 compactions one summary grew from 4k to 25k tokens, with 420 listed paths (122 gone after a relocation), while two early user constraints dropped out                | pi `compaction/compaction.js` `UPDATE_SUMMARIZATION_INSTRUCTIONS`, `extractFileOperations` |

C1 is a symmetry break: fixing it means `totalTokens` = the last cycle's
context plus its output, as
[provider-symmetry.md](provider-symmetry.md#cost-and-process-lifetime) now
records. Long lanes survive C3 because they keep their plan on disk (a tracker
or plan file the agent re-reads after compaction), not because the summary
keeps it.

## Tool and MCP row rendering

The bash half of this was fixed — rows are now labelled by their operative
line rather than their `cd` preamble. The MCP half is untouched, and F1/F2/F3
below are one lane: nothing in `apps/desktop/src/features/chat/` reads an MCP gateway
call's mode.

| #   | Issue                                                                                                                                                                          | Where                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| M1  | Every MCP gateway call renders as `Used mcp`, whichever of its nine modes ran                                                                                                  | `apps/desktop/src/features/chat/tools/toolSummaries.ts` — `default:` branch              |
| M2  | Raw `mcp__server__tool` names leak into the label                                                                                                                              | same file, claude-cli default branch                                                     |
| M3  | `ToolSearch` rows show the machine query (`select:…`, `mcp__custom-tools__…`) instead of the intent                                                                            | same file                                                                                |
| M4  | A failed tool hides its arguments two clicks deep — `isError` never seeds the expanded state                                                                                   | `apps/desktop/src/features/chat/tools/toolDetails.tsx`                                   |
| M5  | The adapter's prose MCP status renders next to the structured chip, because its key is not in the filter                                                                       | `apps/desktop/src/features/extension-ui/ExtensionUiHosts.tsx` — `STRUCTURED_STATUS_KEYS` |
| M6  | `/subagents-stop` without an ID still opens a TUI-only picker and does nothing in RPC. Use **Subagents → select a root → Stop run**, or pass an exact ID to the slash command. | pi-subagents `slash-commands.js`                                                         |

**M2 is pinned by a test.** `apps/desktop/src/features/chat/items/claudeCliRendering.test.ts`
asserts the raw `mcp__linear__save_issue` string reaches the label. Changing
the behaviour means changing that assertion — decide the intent first rather
than treating the test as an accident.

## Trust and recovery

Found in a 2026-09-05 workbench review; all still reproduce.

| #   | Issue                                                                                                              | Where                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| R1  | A conflicting PR still classifies as ready/merge, and a PR with no CI reads "checks green"                         | `apps/desktop/src/features/home/laneState.ts`                            |
| R2  | The lane board's "Merge" is a local `--no-ff` merge, not a PR merge, and nothing in the label says so              | `apps/desktop/src/features/home/LaneBoard.tsx`, `MergeWorktreeModal.tsx` |
| R3  | The Changes inventory is tool-call-only: every write is marked created, and counts accumulate rather than reflect  | `apps/desktop/src/features/files/collectTouchedFiles.ts`                 |
| R5  | A failed worktree creation silently starts the session in the original checkout — no retry, no cancel              | `apps/desktop/src/features/sessions/startChat.ts`                        |
| R6  | A dirty lane with no PR classifies as idle; "Needs a push" also absorbs "changes requested" and "N checks failing" | `apps/desktop/src/features/home/laneState.ts`                            |
| R7  | The model picked on Home is written to the drafts store and never passed into `createSession`                      | `WorkspaceHome.tsx` → `startChat.ts`                                     |
| R8  | Cmd+K lists only the first eight sessions from the current cwd                                                     | `apps/desktop/src/features/palette/CommandPalette.tsx`                   |
| R9  | Home stats cover one cwd while the Ledger beside them is project-wide                                              | `WorkspaceHome.tsx`                                                      |
| R10 | "Resume session" disposes before it looks the session up, so it silently starts a fresh one                        | `apps/desktop/src/features/chat/banners.tsx`                             |

**R11 — modals are not dialogs.** `apps/desktop/src/components/Modal.tsx` has no
`role="dialog"`, no `aria-modal`, no focus trap and no focus restoration, and
the Settings close button has no accessible name. `apps/desktop/src/lib/shortcutContext.ts`
says outright that its data marker exists "without pretending to add a focus
trap". The Changes pane was fixed; this was not.

**R12 — tertiary ink fails contrast**: 2.74:1 on light and 3.77:1 on dark,
against a 4.5:1 bar for normal text (`apps/desktop/src/styles/index.css`). Individual copy
has been migrated to secondary ink, but the tokens themselves are unchanged.

**R13 — deleting a never-reopened session from a sandbox renamed by an older
build orphans the Claude transcript.** Only sessions recorded before provider
0.9.0 have one; current Claude sessions write none.
`apps/desktop/electron/pi/session-deleter.ts` derives
the CLI's copy from the cwd frozen in pi's own header, so a stale header sends
`trashIfPresent` where nothing is and leaves a megabytes-sized file behind.
Mostly closed: `apps/desktop/electron/pi/session-cwd.ts` now rewrites that header for the
whole subtree during `app:renameSandbox`, and again on resume for anything the
rename missed. What is left is the session that predates both and is deleted
without ever being opened — its header is still stale and nothing can un-mangle
a directory name back into a path. Closing it means passing the workspace path
down through `sessions:delete`.

**R14 — a symlinked session directory gives a resumed session two sidebar
rows.** Main resumes through `sessionPathKey` (`realpathSync.native`), so the
live entry's `diskPath` is the resolved path, while the disk scan lists the
file under the path it walked. When the two differ the renderer's
`pendingSessionsByGroup` cannot match them, so the placeholder row never
retires and sits beside the real one until the next scan that agrees. Only
reproduces when the pi agent directory is reached through a symlink (`/tmp` on
macOS, so the routines e2e hits it; a normal `~/.pi/agent` does not). Fixing it
means picking one path identity for a session file and using it on both sides.

## Code health

| #   | Issue                                                                                                                | Where                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| H1  | `errorText` (`libs/shared/src/errors.ts`) is not enforced; 18 hand-rolled `err instanceof Error ? …` sites regressed | across `apps/desktop/src/features/settings/`, `apps/desktop/electron/pi/`                    |
| H3  | One raw `piCommand` site carries no exemption comment, so nobody can tell if it is deliberate (CLAUDE.md #3)         | `apps/desktop/src/features/chat/composer/queueActions.ts`                                    |
| H4  | `useAsyncAction` is not adopted by `MessageItem`, `ForkPickerModal`, `TreeViewModal`                                 | those three files                                                                            |
| H5  | Five symbols are exported but used in exactly one file                                                               | `agent-settings.ts`, `useGlobalShortcuts.ts`, `CommandPalette.tsx`, `libs/shared/src/mcp.ts` |
| H6  | Three separate banner implementations that a single `Notice` primitive would replace                                 | `RetryStrip.tsx`, `banners.tsx`, `composer/RateLimitBanner.tsx`                              |
| H7  | Two hover-action implementations in one file                                                                         | `apps/desktop/src/features/chat/MessageItem.tsx`                                             |
| H8  | Per-component cost rows are still missing from the usage popover                                                     | `apps/desktop/src/features/chat/composer/` — `ContextMeter`                                  |

H1 would hold better as an ESLint rule than as another conversion pass.
