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
| S2  | The whole `tools` record is cloned on every tool-args/output delta (288 µs/event at 1600 tools)             | `src/features/chat/reducer.ts`, `toolIdentity.ts` `withExecutionIdentity` |
| S3  | `buildTranscriptRows` rebuilds the entire transcript per token, defeating `memo` on every visible row       | `src/features/chat/MessageList.tsx` — `useMemo(..., [items])`             |
| S4  | `summarizeTool` re-`JSON.parse`s the accumulated args on every delta — O(n²), 665 ms for one 488 KB `write` | `src/features/chat/tools/toolSummaries.ts` — `tryParseArgs`               |
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

**T3: no interruption recovery marker.** Pi persists a turn only when it ends.
Quit and update restart now confirm active or unconfirmed work before teardown,
but an explicitly stopped turn, OS termination, or crash can still leave no
recoverable transcript for that turn. Main has activity facts and abort logs,
not a durable interruption journal. Editor save/discard prompts and a
wait-until-finished quit action are also still missing. See [updates.md](updates.md).

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

| #   | Issue                                                                                                              | Where                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| R1  | A conflicting PR still classifies as ready/merge, and a PR with no CI reads "checks green"                         | `src/features/home/laneState.ts`                            |
| R2  | The lane board's "Merge" is a local `--no-ff` merge, not a PR merge, and nothing in the label says so              | `src/features/home/LaneBoard.tsx`, `MergeWorktreeModal.tsx` |
| R3  | The Changes inventory is tool-call-only: every write is marked created, and counts accumulate rather than reflect  | `src/features/files/collectTouchedFiles.ts`                 |
| R4  | Restore trashes a file when the baseline lookup **errors**, because `showFileAt` returns `null` for any failure    | `electron/fs/git-service.ts`                                |
| R5  | A failed worktree creation silently starts the session in the original checkout — no retry, no cancel              | `src/features/sessions/startChat.ts`                        |
| R6  | A dirty lane with no PR classifies as idle; "Needs a push" also absorbs "changes requested" and "N checks failing" | `src/features/home/laneState.ts`                            |
| R7  | The model picked on Home is written to the drafts store and never passed into `createSession`                      | `WorkspaceHome.tsx` → `startChat.ts`                        |
| R8  | Cmd+K lists only the first eight sessions from the current cwd                                                     | `src/features/palette/CommandPalette.tsx`                   |
| R9  | Home stats cover one cwd while the Ledger beside them is project-wide                                              | `WorkspaceHome.tsx`                                         |
| R10 | "Resume session" disposes before it looks the session up, so it silently starts a fresh one                        | `src/features/chat/banners.tsx`                             |

**R11 — modals are not dialogs.** `src/components/Modal.tsx` has no
`role="dialog"`, no `aria-modal`, no focus trap and no focus restoration, and
the Settings close button has no accessible name. `src/lib/shortcutContext.ts`
says outright that its data marker exists "without pretending to add a focus
trap". The Changes pane was fixed; this was not.

**R12 — tertiary ink fails contrast**: 2.74:1 on light and 3.77:1 on dark,
against a 4.5:1 bar for normal text (`src/styles/index.css`). Individual copy
has been migrated to secondary ink, but the tokens themselves are unchanged.

**R13 — deleting a never-reopened session from a sandbox renamed by an older
build orphans the Claude transcript.** `electron/pi/session-deleter.ts` derives
the CLI's copy from the cwd frozen in pi's own header, so a stale header sends
`trashIfPresent` where nothing is and leaves a megabytes-sized file behind.
Mostly closed: `electron/pi/session-cwd.ts` now rewrites that header for the
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

**R15 — the session a branch was taken from disappears from the sidebar,
including the source of an explicit Fork or Clone.** Once it isn't live,
`dropSupersededSessions` (`src/features/sessions/superseded.ts`) hides any
file whose name and first entry id match a child's `parentSession` and first
entry. It was written for rewind, but every branching path copies entries with
their ids: pi's `fork`/`clone` (`createBranchedSession`), the sidebar's Fork
(`pi --fork`, `SessionManager.forkFrom`) and the tree view's Fork here
(`forkSessionAt`). So forking a session to try two directions hides the
original as soon as it's closed, along with everything after the branch
point. A rewind hides what it rewound past, which is the intent when the
rewind hit the message the user meant. Before rewind matched rows by
timestamp, it could hit one hundreds of turns earlier. The file is never
touched. Pinned rows skip the filter, and Cmd+K lists the workspace's first
eight disk sessions unfiltered, so opening the file there and pinning it
brings it back.

**R16 — jumping to another branch in the tree view leaves a Claude Code
session answering from the old one.** `jumpHere`
(`src/features/sessions/TreeViewModal.tsx`) appends the branch jump and
reopens the same pi session id. Nothing drops its `pi-claude-cli` pairing, so
the provider resumes the same CLI session. That session's transcript still
holds the abandoned branch, and the provider only sends the messages after the
new branch's last assistant turn. Its staleness check only catches an
assistant turn from another provider. So the model keeps the turns the user
navigated away from. Every other branching path mints a new pi session id and
reimports. `resetClaudeLedgerPairing` is the existing fix to apply after the
jump.

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
