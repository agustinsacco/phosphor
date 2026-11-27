# Known issues

**Defects that reproduce today.** Rows cite the source responsible, not a future
feature. This file describes what is wrong rather than how something works.
The other exception to living contracts is [future-features.md](future-features.md),
which holds directions that are not built.

A row leaves this file when the code changes, in the same diff. If you fix
something here, delete its row — the code becomes the record.

## Streaming and memory

The hot path is pi → main → renderer. These were measured with benchmarks
against real session files; the numbers are from that audit and the code paths
are unchanged.

| #   | Issue                                                                                                       | Where                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| S2  | The whole `tools` record is cloned on every tool-args/output delta (288 µs/event at 1600 tools)             | `libs/client-ui/src/features/chat/reducer.ts`, `toolIdentity.ts` `withExecutionIdentity` |
| S3  | `buildTranscriptRows` rebuilds the entire transcript per token, defeating `memo` on every visible row       | `libs/client-ui/src/features/chat/MessageList.tsx` — `useMemo(..., [items])`             |
| S4  | `summarizeTool` re-`JSON.parse`s the accumulated args on every delta — O(n²), 665 ms for one 488 KB `write` | `libs/client-ui/src/features/chat/tools/toolSummaries.ts` — `tryParseArgs`               |
| S6  | `message_end` fold is O(items + tools), and pi emits one message per tool call ⇒ O(n²) per session          | `libs/client-ui/src/features/chat/toolIdentity.ts`, `messageContent.ts`                  |
| S7  | `FilesChangedPane` re-derives every touched file (re-parsing every patch) on every tool delta               | `libs/client-ui/src/features/files/FilesChangedPane.tsx` — depends on `tools` (S2)       |
| S8  | Artifact `versions[]` grows unbounded with full content per version, duplicated on the tool payload         | `libs/client-ui/src/stores/artifacts.ts`                                                 |

Two more that are worth reading in full because their history is misleading:

- **S10 — `releaseWorkspace` runs only for Host lanes.** It is the documented
  fix for editor/Monaco retention in `libs/client-ui/src/stores/files.ts`. Session
  cleanup in `libs/client-ui/src/stores/sessions.ts` calls it when a Host lane
  goes away; an in-app lane's workspace is never released.
- **S11 — live pi subprocesses are unbounded.** ~172 MB RSS for one _idle_ pi
  tree, and nothing reclaims them. This was genuinely fixed once by an
  idle-session reaper, and then the reaper was deleted wholesale with the
  orchestration removal on 2026-09-03. Today the only `suspendSession` caller
  is the sidebar menu, and every `disposeSession` caller is user-driven. Treat
  "there is no cross-session manager" (AGENTS.md fact 5) as deliberate and this
  as the cost of it.

- **S14 — while following the tail, a collapsing activity row's re-measure
  scrolls to the virtualizer's cached offset.** TanStack compensates a
  re-measured row above the fold with `scrollTo(cachedOffset + delta)`, and
  that cached offset is the last scroll event's value: one frame behind the
  follow effect's `scrollTop = scrollHeight`. Each 220 ms activity-group
  collapse (`.activity-group-body`) during a stream therefore overrides the
  follow for several consecutive frames (measured: 11 frames at 120 Hz with the
  view held ~1000 px above the tail, then one jump).
  `libs/client-ui/src/features/chat/MessageList.tsx` — `useVirtualizer`'s default
  `scrollToFn`. A custom `scrollToFn` that drops adjustments while pinned and
  applies them relative to the live `scrollTop` while unpinned is the likely
  fix; it is not in yet because it changes read-back behaviour that only the
  e2e transcript suite covers.

**S13 — the captured reducer/e2e fixture uses the pre-0.84.0 wire shape.**
`libs/client-ui/src/features/chat/__fixtures__/real-session-events.jsonl` carries `message`
and `assistantMessageEvent.partial` on all 193 `message_update` records and no
top-level `usage`; `partial` alone is 42.8% of its bytes. `apps/desktop/e2e/fixtures/pi-stub.cjs`
still emits that older shape on some paths, while other stub paths emit lean
updates. The captured fixture does not represent the current lean wire format.

## macOS

| #   | Issue                                                                                                                                                                                                                                                                                                                                                                               | Where                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| K1  | A signed-in ad-hoc build asks for the "Phosphor Safe Storage" Keychain item again after every update, even after Always Allow. The pinned designated requirement does not help here: the login keychain also matches the item's partition list, which for code without a Team ID is the per-build `cdhash`. Phosphor keeps working while the prompt is open. A Developer ID ends it | `apps/desktop/scripts/adhoc-sign-mac.mjs`, `MAC_CERT_P12` in CI |

## Linux

| #   | Issue                                                                                                                                                                                                                                                                                       | Where                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| L1  | With both `session.bin` and `session.txt` left behind (a keyring that went away) and no keyring running, sign-out removes both locally but does not revoke the session on Supabase: the plain file is read only after the encrypted one fails to decrypt, by which time sign-out deleted it | `apps/desktop/electron/account/vault-token.ts` `readVaultToken` |

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
| C1  | A Claude session under-counts its context by the last response's output. The provider reports `usage.totalTokens` without output; pi's Anthropic provider includes it, and pi's threshold check trusts that field. A 20-53k thinking response let requests through at 401k and 415k on a 400k budget, and the meter reads low | pi-claude-cli `src/event-bridge.ts` `recomputeUsage`; fixed in 0.11.0                      |
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
line rather than their `cd` preamble. pi's own MCP tools (`codemode`,
`tool_search`) have rows of their own; M1 to M3 concern older transcripts
(the adapter's gateway, Claude Code marker sessions).

| #   | Issue                                                                                                                                                                                                                                                                                              | Where                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| M1  | A pi-mcp-adapter `mcp` gateway call in an older transcript renders as `Used mcp`, whichever of its nine modes ran                                                                                                                                                                                  | `libs/client-ui/src/features/chat/tools/toolSummaries.ts` — `default:` branch |
| M2  | Raw `mcp__server__tool` names leak into the label                                                                                                                                                                                                                                                  | same file, claude-cli default branch                                          |
| M3  | `ToolSearch` rows show the machine query (`select:…`, `mcp__custom-tools__…`) instead of the intent                                                                                                                                                                                                | same file                                                                     |
| M4  | A failed tool hides its arguments two clicks deep — `isError` never seeds the expanded state                                                                                                                                                                                                       | `libs/client-ui/src/features/chat/tools/toolDetails.tsx`                      |
| M6  | `/subagents-stop` without an ID still opens a TUI-only picker and does nothing in RPC. Use **Subagents → select a root → Stop run**, or pass an exact ID to the slash command.                                                                                                                     | pi-subagents `slash-commands.js`                                              |
| M7  | After an automatic compaction inside a long parent turn, background agents read **status unavailable** until the turn ends: pi-subagents withdraws its snapshot on `session_before_compact` and resumes only on `agent_start`/`agent_settled`. Fix proposed upstream: nicobailon/pi-subagents#2891 | pi-subagents 0.77 `extension/index.js` `suspendWidgetsForCompaction`          |

**M2 is pinned by a test.** `libs/client-ui/src/features/chat/items/claudeCliRendering.test.ts`
asserts the raw `mcp__linear__save_issue` string reaches the label. Changing
the behaviour means changing that assertion — decide the intent first rather
than treating the test as an accident.

## Trust and recovery

Found in a 2026-09-05 workbench review; all still reproduce.

| #   | Issue                                                                                                                              | Where                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| R2  | The lane board's "Merge" is a local `--no-ff` merge, not a PR merge, and nothing in the label says so                              | `libs/client-ui/src/features/home/LaneBoard.tsx`, `MergeWorktreeModal.tsx` |
| R3  | The Changes inventory is tool-call-only: every write is marked created, and counts accumulate rather than reflect                  | `libs/client-ui/src/features/files/collectTouchedFiles.ts`                 |
| R5  | A failed worktree creation starts in the original checkout with a warning, but no retry or cancel                                  | `libs/client-ui/src/features/sessions/startChat.ts`                        |
| R6  | A dirty lane with no PR classifies as idle; "Needs a push" also absorbs "changes requested" and "N checks failing"                 | `libs/client-ui/src/features/home/laneState.ts`                            |
| R7  | The model picked on Home is written to the drafts store and never passed into `createSession`                                      | `WorkspaceHome.tsx` → `startChat.ts`                                       |
| R9  | Home stats cover one cwd while the Ledger beside them is project-wide                                                              | `WorkspaceHome.tsx`                                                        |
| R10 | A This Mac lane that settles before its git info loads gets a receipt naming the worktree folder as the repository, with no branch | `libs/client-ui/src/features/sessions/laneNotices.ts` `noticeLaneSettled`  |

**R11 — modals are not dialogs.** `libs/client-ui/src/components/Modal.tsx` has no
`role="dialog"`, no `aria-modal`, no focus trap and no focus restoration.
Settings supplies its own dialog attributes and accessible close label, but the
shared overlay supplies no focus management. `libs/client-ui/src/lib/shortcutContext.ts`
says outright that its data marker exists "without pretending to add a focus
trap". The Changes pane was fixed; this was not.

**R12 — tertiary ink fails contrast**: 2.74:1 on light and 3.77:1 on dark,
against a 4.5:1 bar for normal text (`libs/client-ui/src/styles/index.css`). Individual copy
has been migrated to secondary ink, but the tokens themselves are unchanged.

**R13 — deleting a never-reopened session from a sandbox renamed by an older
build orphans the Claude transcript.** Only sessions recorded before provider
0.9.0 have one; current Claude sessions write none.
`apps/desktop/electron/pi/session-deleter.ts` derives
the CLI's copy from the cwd frozen in pi's own header, so a stale header sends
`trashIfPresent` where nothing is and leaves a megabytes-sized file behind.
Mostly closed: `libs/session-runtime/src/pi/session-cwd.ts` now rewrites that header for the
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

**R15 — Open in the Move dialog can close a later Move dialog.** `openMoved` in
`libs/client-ui/src/features/sessions/LaneMoveModal.tsx` awaits the scan and resume
with no pending state, so Done stays enabled. When an Open that outlived its
dialog finishes, it still navigates and calls the store's global `close`
(`libs/client-ui/src/stores/laneMove.ts`), dismissing whichever Move dialog is
open by then.

**R16 — a lane moved to another workspace on the same Mac borrows the
original's attachments.** Same-machine export skips attachment parts
(`apps/desktop/electron/lane-move/local.ts`, `attachmentAllowed`) and the copy keeps
the old paths. When the original came from a Host, those paths sit under
`<userData>/lane-attachments/<original id>/`, which
`apps/desktop/electron/pi/session-deleter.ts` trashes with the original, so
deleting it breaks the copy's attachments.

## Code health

| #   | Issue                                                                                                            | Where                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| H1  | `errorText` (`libs/shared/src/errors.ts`) is not enforced; hand-rolled `err instanceof Error ? …` sites remain   | across `libs/client-ui/src/features/settings/`, `apps/desktop/electron/pi/` |
| H3  | One raw `piCommand` site carries no exemption comment, so nobody can tell if it is deliberate (AGENTS.md fact 3) | `libs/client-ui/src/features/chat/composer/queueActions.ts`                 |
| H4  | `useAsyncAction` is not adopted by `MessageItem`, `ForkPickerModal`, `TreeViewModal`                             | those three files                                                           |
| H5  | Several public helpers have only one production consumer                                                         | `apps/desktop/electron/pi/agent-settings.ts`, `libs/shared/src/mcp.ts`      |
| H6  | The transcript-top banners do not share the composer notices' `ComposerNotice` shell                             | `libs/client-ui/src/features/chat/banners.tsx`                              |
| H7  | Two hover-action implementations in one file                                                                     | `libs/client-ui/src/features/chat/MessageItem.tsx`                          |
| H8  | Per-component cost rows are still missing from the usage popover                                                 | `libs/client-ui/src/features/chat/composer/` — `ContextMeter`               |

H1 would hold better as an ESLint rule than as another conversion pass.

## Host lanes

| #   | Issue                                                                                                                                                                                                                                                                                              | Where                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HL1 | An extension can move pi to another session file without updating the Host lane index. Normal Stop and model changes learn the current file, but daemon shutdown or a crash before either leaves the old stored transcript for later snapshot and resume.                                          | `apps/host/src/lanes/runtime-host.ts`, `apps/host/src/lanes/runtime-host/model-switch.ts`, `apps/host/src/lanes/store.ts`                                            |
| HL2 | Same-provider Host model selections with model ids over 128 characters succeed live but cannot be persisted; after stopping, the lane summary shows its previous stored model. Cross-provider selections with provider ids over 64 or model ids over 128 characters are refused before pi changes. | `apps/host/src/lanes/runtime-host/model-switch.ts`, `apps/host/src/lanes/store.ts`, `apps/host/src/lanes/schema.ts`                                                  |
| HL3 | A lane's branch follows only its own folder. When the agent adds a worktree elsewhere (`git worktree add ../x`) and works there, the lane row and header keep the folder's branch, typically `main`, and `worktree` stays false: the lane's folder and worktree flag are fixed at creation.        | `apps/host/src/lanes/runtime-host/branch.ts`, `apps/host/src/lanes/store.ts`                                                                                         |
| HL4 | Right after a stopped lane starts again, the composer's model chip and context readout can briefly show the previous pi process's meta and stats until the new process's replies land.                                                                                                             | `libs/client-ui/src/features/chat/composer/ModelPicker.tsx`, `libs/client-ui/src/features/chat/composer/ContextReadout.tsx`, `libs/client-ui/src/stores/sessions.ts` |
| HL5 | An Intel Mac Host cannot update itself: the updater (`fetchSignedRelease`) reads only the v1 manifest, which has no `darwin-x64`. Its self-check therefore offers no update there, and an Intel Mac Host is updated by reinstalling.                                                               | `libs/session-runtime/src/host-install/fetch.ts`, `apps/host/src/update/check.ts`                                                                                    |

## This Mac’s service

These limits apply to the [service runtime and migration](local-service.md), not to ordinary in-app launches unless noted.

| Issue                                  | Consequence                                                                                                                                                                                                                                                    | Where                                                                                                |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| N6 · Migration capacity                | More than 64 folders or 1,000 planned lanes keeps This Mac in-app; a partial inventory is not migrated.                                                                                                                                                        | `local-machine/migration/plan.ts`                                                                    |
| Old Desktop after migration            | An old build starts with an empty local home and no old routines to run, but manual folder addition can reopen a service-owned lane. Do not use an old build to open migrated work.                                                                            | `local-machine/migration/quarantine.ts`                                                              |
| Old Desktop detection                  | If legacy prefs or routines show that an older Desktop has used the data, the tripwire warns once. Lanes it created are discovered on the next service restart, not by a live rescan.                                                                          | `local-machine/launch.ts`, `migration/tripwire.ts`                                                   |
| Restore is recovery, not a mode switch | Stop service lanes first. Restore needs confirmed standby and brings back pre-migration pins and routines, not later edits. Cleared draft images cannot be restored.                                                                                           | `local-machine/restore.ts`, `restore-service.ts`                                                     |
| Claude account capacity                | Import or registration cannot exceed the Host limit of 16 accounts.                                                                                                                                                                                            | `apps/host/src/owner/import/accounts.ts`, `apps/host/src/providers/login-account.ts`                 |
| Maintenance after migration            | The maintenance scan still checks Desktop’s path-keyed pins. A migrated pin by itself no longer protects a conversation from reclamation. Review candidates rather than relying on a pin.                                                                      | `apps/desktop/electron/maintenance/conversations.ts`, `local-machine/migration/quarantine.ts`        |
| Brain lane in daemon mode              | Defrag runs, but the Brain lane is Desktop-private: the Brain strip's **Brain lane** button is refused, so you cannot open the lane to watch or answer Brain Agent, and no window answers a dialog it raises.                                                  | `libs/client-ui/src/features/brain/openBrainSource.ts`, `apps/desktop/electron/pi/session-events.ts` |
| Account merge                          | Consent cannot merge signed-in Claude accounts across two account roots when the service already has credential folders of its own.                                                                                                                            | `apps/host/src/owner/import/accounts.ts`                                                             |
| Clone on a non-default Claude account  | The clone looks up the CLI ledger using the process environment, not the lane’s assigned account directory. A miss reimports the conversation on the first turn (a full-context cache write, not someone else’s history). In-app clones share this limitation. | `libs/session-runtime/src/claude/ledger.ts`, `apps/host/src/lanes/editing.ts`                        |
| Terminals                              | After migration This Mac is limited to 32 open terminals across lanes, even for the attested owner.                                                                                                                                                            | `apps/host/src/api/owner-exemptions.ts`                                                              |
| Default context files                  | Migration preserves the CLAUDE.md / AGENTS.md default for new lanes, but Settings has no Host control for it. Sources are migration, Host `config.json`, or `machine.settings.patch` with `agent.patch`.                                                       | `owner/import/policy.ts`, `settings/agent-settings.ts` in `apps/host/src/`                           |
| Artifact listing                       | Rows beyond the service library’s count or metadata caps are omitted, not removed. A generated slug with a doubled hyphen also fails client validation and is omitted.                                                                                         | `apps/host/src/ops/handlers/artifacts.ts`, `libs/shared/src/host-protocol-artifacts.ts`              |
| Marker reset                           | `lane.marker` stores `none` literally; it does not clear the stored mark back to automatic.                                                                                                                                                                    | `apps/host/src/ops/handlers/lane-self.ts`                                                            |

## In-app Headroom fallback

Desktop in-app mode still adopts a healthy listener on `127.0.0.1:8787` (`apps/desktop/electron/headroom/proxy.ts`). On a shared machine that listener can belong to someone else. Leave compression off in this mode if the listener is not trusted. The local daemon does not adopt it.
