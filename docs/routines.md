# Routines

A routine is saved instructions plus a workspace, model, and schedule. Each run
creates a **fresh ordinary pi session**, with an optional fresh Git worktree.
It is local trusted automation, not a cloud runner, sandbox, or cross-lane
orchestrator. Interactive sessions remain independent.

## Setup and navigation

**Routines** in the sidebar opens a global page. New routine asks what to do,
where to run, which model to use, and when. The name is optional in the editor
and derives from the first instruction line. Choose code/PR or analysis/report
intent; report intent suppresses Phosphor's automatic worktree PR charter.
Project rules and custom directives still apply. The model field is the
composer's searchable model menu (search, provider filters, starred and recent),
not a flat list; a saved model the catalogue no longer lists stays selected and
is flagged rather than silently replaced.

The editor only closes on purpose: ✕ or Escape, never a click on the backdrop
(Escape inside the model menu closes just the menu). Whatever it holds when it
closes is kept in memory and comes back the next time that draft slot opens.
Saved-routine edits use the routine's slot; new-routine drafts have one slot per
machine; All machines uses the This Mac slot. **New routine** reads **Resume draft**
when that slot holds work. The slot stays fixed for the whole edit, even if the draft's target machine
changes or becomes unavailable. Return to the original slot to resume it.
**Reset** returns to a blank routine, or to the saved one when editing. Drafts do
not survive a restart and never touch disk before Save. An edit draft started
from an older revision is dropped, since saving it would be refused as stale. Starters,
Duplicate, Import and Make routine… open fresh and replace a waiting new draft.

The page includes starter instructions for weekly analysis, dependency audits,
and cycle retros. A lane's context menu offers **Make routine…**: a reviewable
draft of its name, first user text, and workspace, not its running process or
entire conversation. Choose the model explicitly before saving that draft.

Schedules: Manual, Hourly, Daily, Weekdays, Weekly, Monthly (including last day),
Once, or Custom five-field cron. The editor previews the next three occurrences in the
saved timezone, with offsets. Changing the machine timezone does not change
existing schedules. Custom cron uses conventional day-of-month/weekday OR
semantics; randomized `H` fields and six-field/seconds expressions are refused.
Nonexistent DST wall times are skipped, not rolled forward. Repeated wall-clock
minutes run at their first occurrence only. A monthly day absent from a month
is skipped. One-off times have one absolute timestamp and no next occurrence
after firing.

**Check setup** checks the workspace, pi availability, and whether Git isolation
is possible, without running a model. It also runs the folder-task gates the
runner will run and reports whichever would refuse the run right now as a
warning rather than an error, because a live session or a dirty tree is
transient and usually resolves before a scheduled occurrence fires. Only a
permanent misconfiguration (missing pi, isolation without a repository) throws.
Enable checks setup automatically and is likewise not blocked by a warning.
Authentication, provider limits, and actual task results require a real run.
**Run now is not a dry run:** it can change files and connected services.

Every enabled routine requires acknowledgement of unattended full tool access.
Edits to execution configuration clear that acknowledgement in the editor.
Save paused preserves a template; an acknowledged paused template can still
run manually. Imports always start paused and untrusted. Exports include
instructions and configuration, not stored account credentials or run history.

## Execution and history

- Every run captures the full effective routine definition and its revision.
  Editing or pausing cancels queued snapshots; a running snapshot is unchanged.
  Stale concurrent edits are refused instead of overwriting a newer revision.
- Exact provider/model identity is verified before sending the first prompt.
  There is no silent model fallback. Claude accounts use the existing account
  routing policy, and the chosen account is bound to the session file.
- Isolated runs branch from the locally known trunk/start point using
  `createLaneWorkspace`. The base commit is recorded. This path does not fetch
  a fresh remote before every run. An isolation failure **blocks**; it never
  falls back into the main checkout. Worktree folders are never automatically
  deleted by the routine runner.
- Folder tasks refuse a workspace held by a live session, either intent. A
  **code** folder task additionally refuses a dirty Git checkout, counting
  untracked files, and the reason names the count. A **report** folder task
  does not: reading a checkout you are still editing is the one thing a fresh
  worktree cannot do, since it branches from trunk. Report is an instruction,
  not enforced read-only access, so this is a deliberate relaxation. Both gates
  protect against other Phosphor sessions, not unrelated editors or terminal
  processes. Worktrees are not filesystem/network sandboxes.
- Optional previous-day or previous-week reporting periods use the **scheduled
  time** in the pinned timezone, not the actual start time. Weeks are Monday–
  Sunday; the end timestamp is exclusive. The prompt receives both timestamps,
  the period, timezone, and stable run ID.
- History shows scheduled/started/ended times, trigger, revision, instructions,
  working folder, branch, base commit, account ID when known, reason, and a
  bounded final summary. Older history is paginated.
- A routine's page leads with its settings as one list (schedule, model,
  workspace, execution and intent, limits, revision, instructions) and keeps
  two buttons, Run now and Edit. Pause/Review and enable, Skip next run,
  Duplicate, Export, Archive and Delete live in its **⋯** menu.
- **Archive** hides the routine and keeps everything. **Delete** removes the
  definition and its whole run history, after a confirmation. It is refused
  while a run is executing; queued runs go with it. Lanes the routine still
  owns (never continued) are trashed through the same path as deleting a lane
  from the sidebar, so they are recoverable from the trash. Lanes you continued
  already belong to their workspace and stay. Worktrees are not deleted: the
  maintenance sweep reclaims them under its usual rules (never a dirty tree,
  never an unlanded branch).
- **Runs are grouped by day, newest first, and the most recent day starts
  open.** The day heading uses your own clock, because routines pinned to
  different timezones share one list; each run still prints its times in its
  own routine's zone. A run belongs to the day it started, falling back to the
  day it was scheduled. Filters narrow by routine, workspace, scheduled vs
  one-off, and failures only. A one-off is a trigger, not a separate kind of
  routine: Run now, or a routine whose whole schedule is a single time. The
  same list appears twice — on the Routines page as **Activity** across every
  routine (the recent-runs snapshot), and inside a routine scoped to it (its
  full paginated history).
- **A routine's lanes are not listed in the sidebar.** Run history is where
  they live, so the workspace lane list stays the conversations you started.
  Main keeps a lane index (session file path → run) covering every run ever
  recorded, not just the snapshot's recent window; the sidebar hides exactly
  those paths. A routines subsystem that failed to start returns an empty
  index and hides nothing.
- **Opening a lane from history promotes it.** There is no read-only
  transcript view — reopening a session file spawns a real pi process — so
  opening one hands it back to its workspace: it leaves the lane index, gains
  an ordinary sidebar row, and the routine will not use it again. The
  confirmation names the folder and branch, which is the one thing a folder
  task can surprise you with. Promotion is one-way and never deletes history.
  A lane promoted while its run is still executing stays owned by the routine
  until that run ends; it is visible so you can watch it.
- `Finished · unverified` means the agent returned a written outcome, **not**
  that its report, tests, or external deliveries were independently verified.
  Empty outcomes and provider errors fail. On Desktop and Host, top-level tool
  errors add a warning even when the final message claims success. Nested tool
  failures are the parent tool's responsibility: a successful parent does not
  add a tool-error warning, but a failed parent does. All tool errors remain
  visible in the transcript. There is no delivery-receipt gateway.
- Main owns execution even with zero renderer windows. Opening a running lane
  adopts its existing process, never a second writer of the same transcript.
  Mutating RPC commands are blocked while the routine owns that session.
- Unobserved runs dispose their pi process when done. An explicitly opened,
  successfully finished lane becomes an ordinary live interactive session for
  follow-up. It can be suspended normally; a live folder-task session must be
  suspended before another routine can use the same folder.

## Scheduling and failure policy

The scheduler checks every 15 seconds and reconciles on launch and wake. Times
are due times, not exact-start guarantees. No random stagger is added.

| Condition                            | Behavior                                                             |
| ------------------------------------ | -------------------------------------------------------------------- |
| Missed occurrences                   | Latest only, within configurable 0–168h window (24h default)         |
| Long downtime                        | One skipped-range record plus the latest eligible occurrence         |
| Catch-up set to 0                    | Skip missed runs, allowing one minute for normal scheduler latency   |
| Overlap                              | One running and at most one pending scheduled occurrence per routine |
| Newer occurrence                     | Supersedes the older pending scheduled occurrence with a reason      |
| Concurrency                          | Two routine workers maximum; source folders also serialize           |
| Queued deadline                      | Same catch-up window, with one-minute minimum                        |
| Run now                              | Deduplicated, no overlap, does not move the recurring clock          |
| Pause                                | Cancels queued snapshots, not the active execution                   |
| Resume                               | Future occurrences only; paused time is not caught up                |
| Runtime limit                        | 1–240 minutes; default 30, including preparation                     |
| Task retry                           | None automatically; pi's whole-turn auto-retry is disabled           |
| Unexpected dialog/auth               | Block and pause; never auto-answer or launch OAuth                   |
| Three consecutive execution failures | Pause with a persistent attention reason                             |
| Cancel/timeout                       | Stop execution; preserve history and possible partial effects        |
| Interrupted process/app              | Unknown outcome, paused, no automatic replay                         |

A cancellation request holds the admission slot until execution cleanup returns.
Deleting a running routine's session from the sidebar uses that same cancellation
path and waits for cleanup before trashing the transcript.
On POSIX, routine pi processes own a process group; cleanup signals that group,
including nested providers that inherit it. Windows uses `taskkill /T /F`.
This is process cleanup, not a containment guarantee for independently detached
or remote work. Force-killing Phosphor can leave an orphan; recovery pauses the
routine and explicitly requires checking old workers and partial effects before
saving to resume. It never kills a stale PID that could belong to another app.

External writes are not transactional with SQLite. A lost network response can
mean a Slack post, Notion update, or PR already exists. Inspect the prior lane
before a manual rerun; local occurrence deduplication cannot guarantee
exactly-once external effects. There are no enforced read-only modes, spend
caps, automatic publishing retries, or per-destination allowlists.

## Background operation and storage

**Keep Phosphor running after closing its windows** opts into a visible
tray/menu-bar control with Open, Pause all, and Quit. On non-macOS platforms,
last-window-close otherwise quits. On macOS, the existing app lifecycle keeps
main running until Quit. Quit/update shutdown stops admission, aborts active
routine work, and persists interrupted outcomes before disposing other sessions.
Sleep, lid close, shutdown, and network/provider outages still prevent execution.
There is no launch-at-login setting or automatic wake scheduling for routines.

The main-process `RoutineRepository` uses Electron's built-in `node:sqlite`:
`<userData>/routines.sqlite`, WAL, FULL synchronous writes, schema version 1.
Definitions, run snapshots, cursor advances, and occurrence identities commit
transactionally. The app's single-instance lock provides one scheduler/writer;
runs also have unique occurrence keys and conditional claims. No per-routine
idle subprocesses, renderer timers, or separate live-session registry exist.

Development uses `routines-dev.sqlite`; stubbed E2E uses its isolated userData.
A normal dev launch cannot run the installed app's routines. Startup/storage
errors stop routine scheduling rather than recreating an empty database or
silently discarding history. Back up the database only while the app is quit
(or with a SQLite-aware backup); do not copy a live WAL database file alone.
History is retained until the routine is deleted or the app data is removed;
automatic retention is not implemented. Non-archived routine source folders and
pending run workspaces are protected from automatic maintenance reclamation.

## Host routines

The global page follows the sidebar machine; sidebar All machines defaults the
page to This Mac. Its picker can select All machines or override the target until
the next sidebar change. This selection is window-local and never persisted.

The list and header count follow the page selection; the count includes only
non-archived routines in that selection. A Host page shows no This Mac activity,
load errors, footer or background controls. Host run history opens from each routine,
not a mixed Activity feed. All machines explicitly labels local Activity and
load errors as **This Mac**. An unavailable Host shows its refusal, never local data
under a remote label. Changing the selection clears an action error shown for the
previous machine.
Remote editors and detail labels use the Host model catalogue. Changing the
execution machine clears the old model choice. Remote history shows output as
unavailable until the Host supplies a lane identity, not a local Continue action.
A machine switch closes a detail or editor belonging to the previous machine.

The Host daemon owns its own scheduler and SQLite database at
`<state>/routines/state.sqlite`. The Host footer states that routines run while
the Host is running and awake; Desktop can be closed. The scheduler belongs to
the Host daemon, not a Desktop window or connection.
Desktop's local scheduler, notifications, background setting and database do not
change. The Routines page lists this computer and every connected machine that
announces `routines`, with a machine tag and filter. In All machines, local rows
load first; an unavailable machine has its own status and never hides local rows.
Definitions and history are fetched independently and refreshed on Host
`routines-changed` invalidations or connection changes.

Choose a machine in New routine. After creation that machine is fixed. On a
Host, the workspace picker lists only that machine's configured repository
labels, not folders or Host paths. Drafts keep machine and repository choices
with their inputs, under the fixed [draft-slot rules](#setup-and-navigation). A
repository no longer offered is cleared and requires a fresh choice before saving. A missing machine never falls back to this computer; an
existing routine stays locked to its machine and cannot save while it is absent.
Remote list rows say **Open for run history**, not whether a run has occurred.
Save paused creates a paused, untrusted
routine. Reopen Edit, acknowledge unattended full tool access, then choose
**Enable on <machine>** as a separate explicit save. Enable, Run now and Delete
are disabled without `sessions.control`, with the existing read-only hint.
Main checks capabilities again, even if a renderer tries to bypass the UI.
The machine filter scopes **Pause all** to that machine; All machines keeps
the local Pause all behavior.

Remote history shows only status and scheduled/started/ended timestamps. Host
transcripts, working folders and execution diagnostics do not reach Desktop.
An uncertain mutation displays “The outcome is unknown. Refresh before taking
another action.” It is never resent. Refresh loads the machine's current
state before another mutation is admitted.

Remote definitions name a configured `repositoryId`, never a filesystem path.
Creation always stores a paused, untrusted definition. A later explicit controller
save can acknowledge full unattended tool access and enable the schedule. That
acknowledgment persists in Host SQLite; a browser lease never enables automation.

| Operation                                            | Connection capabilities           |
| ---------------------------------------------------- | --------------------------------- |
| List, history, cancel, skip next, archive, pause all | `routines`                        |
| Save paused and untrusted                            | `routines`                        |
| Save trusted or enabled, run now, delete             | `routines` and `sessions.control` |

Machine-scoped commands carry request ids, have no lane id or fence, and use the
Host receipt ledger. Admission uses the current connection capabilities, including
a second check when queued work reaches execution. Closed connections have no
capabilities for queued work. Receipts remain client-scoped and are not
capability-gated. A duplicate command returns its receipt, never another execution.
An uncertain delivery or restart does not automatically repeat external effects.

The portable engine keeps the same two-worker limit, source-folder serialization,
calendar/DST rules, catch-up policy and failure pauses as Desktop. The Host runner
uses the shared session service and deletion path-lock domain. It verifies the
exact model, disables automatic retries before the first prompt, blocks unexpected
dialogs without answering them and disposes its worker after completion. Folder
code tasks refuse dirty repositories; either intent refuses a live session in the
source folder. Failed worktree isolation never falls back to the source folder.
Running routine sessions reject manual mutation and manual stop.

A routine never types into a terminal. It does not claim terminal occupancy or
exclude a shell editing the same folder. Terminals and external editors are not a
filesystem lock. Use isolated worktrees when simultaneous edits are possible.

`routines.list` returns at most 100 definitions, including archived definitions.
`routines.history` returns at most 50 status/timestamp records, with a bounded
pagination offset. Neither returns Host session paths, working folders, account
ids or private execution diagnostics. Full run snapshots and output remain in
Host SQLite. Delete refuses a running execution or more than 1,000 history rows.
It archives first so no schedule starts during transcript removal, removes owned
transcripts through the shared runtime, then deletes the definition and history.
A partially failed deletion is not retried automatically. Worktrees are retained.
Small `routines-changed` invalidations publish on the lanes topic; subscribers
refetch the routines queries.

## Code map and tests

- `libs/shared/src/routines-types.ts`: dependency-free routine shapes.
- `libs/shared/src/host-protocol-routines.ts`: bounded Host wire parsers.
- `apps/host/src/routines/`: daemon wiring, repository identity mapping and runner.
- `libs/shared/src/routines.ts`: schema validation, cron/timezone calculations, reporting
  periods, deterministic execution prompt. Uses cron-parser and Luxon.
- `libs/session-runtime/src/routines/`: SQLite repository, routine-only scheduler,
  outcome classification and ownership guard. The scheduler takes a lifecycle port.
- `apps/desktop/electron/routines/`: thin portable-engine exports, Desktop shutdown
  approval adapter, runner, startup wiring and background tray. `preflight.ts` holds
  the folder-task gates so the runner and `routines:check` cannot disagree
  about what blocks a run.
- `apps/desktop/electron/pi/session-runtime.ts`: Desktop bindings for `libs/session-runtime/src/pi/` startup
  and session admission. Routine startup and interactive IPC use the same
  provider-guarded service; routine startup and execution remain owned by their execution machine.
- `apps/desktop/electron/ipc/routines-handlers.ts`, `libs/shared/src/ipc/services.ts`, `apps/desktop/electron/preload.ts`:
  typed operations and snapshot invalidations. `libs/client-ui/src/dev/mockRoutines.ts` is a
  clearly labelled browser simulation with no model execution.
- `useRoutineLaneIndex` (`libs/client-ui/src/stores/routines.ts`) keeps the lane index fresh
  for the sidebar, which needs it before Routines has ever been opened. The
  sidebar passes it to `groupSessionsByProject`'s `isHidden` predicate, the
  same one that moves pinned sessions out of their project group.
- `libs/client-ui/src/features/routines/`, `libs/client-ui/src/stores/routines.ts`: editor, overview, history,
  and projection of main state. No renderer-owned scheduling.
  `ActivityAccordion.tsx` renders the run list for both scopes; the grouping
  and filtering rules are pure functions in `runGroups.ts` so they can be
  tested without a DOM.

Tests cover calendar/DST behavior, validation, deduplication, transactional
history, restarts, limits, cancellation, failure pauses, model/isolation refusal,
no-window execution, process-group cleanup, and UI create/run/reopen flows.
The deterministic pi stub does not validate real provider authentication,
native-tool behavior, remote side effects, or analytical correctness.
