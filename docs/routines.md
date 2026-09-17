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
Project rules and custom directives still apply.

The page includes starter instructions for weekly analysis, dependency audits,
and cycle retros. A lane's context menu offers **Make routine…**: a reviewable
draft of its name, first user text, and workspace, not its running process or
entire conversation. Choose the model explicitly before saving that draft.

Schedules: Manual, Hourly, Daily, Weekdays, Weekly, Monthly (including last day),
Once, or Custom five-field cron. The editor previews five occurrences in the
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
  bounded final summary. **Open lane** uses the ordinary transcript and artifact
  UI. Older history is paginated; archiving never deletes history or worktrees.
- `Finished · unverified` means the agent returned a written outcome, **not**
  that its report, tests, or external deliveries were independently verified.
  Empty outcomes and provider errors fail. Tool errors remain visible even
  when the final message claims success. There is no delivery-receipt gateway.
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
History is retained until the app data is explicitly removed; automatic
retention/deletion is not implemented. Non-archived routine source folders and
pending run workspaces are protected from automatic maintenance reclamation.

## Code map and tests

- `shared/routines.ts`: schema validation, cron/timezone calculations, reporting
  periods, deterministic execution prompt. Uses cron-parser and Luxon.
- `electron/routines/`: SQLite repository, routine-only scheduler, runner,
  ownership guard, startup wiring, and background tray. `preflight.ts` holds
  the folder-task gates so the runner and `routines:check` cannot disagree
  about what blocks a run.
- `electron/pi/session-runtime.ts`: shared window-independent session spawn;
  interactive IPC still calls this same provider-guarded runtime.
- `electron/ipc/routines-handlers.ts`, `shared/ipc.ts`, `electron/preload.ts`:
  typed operations and snapshot invalidations. `src/dev/mockRoutines.ts` is a
  clearly labelled browser simulation with no model execution.
- `src/features/routines/`, `src/stores/routines.ts`: editor, overview, history,
  and projection of main state. No renderer-owned scheduling.

Tests cover calendar/DST behavior, validation, deduplication, transactional
history, restarts, limits, cancellation, failure pauses, model/isolation refusal,
no-window execution, process-group cleanup, and UI create/run/reopen flows.
The deterministic pi stub does not validate real provider authentication,
native-tool behavior, remote side effects, or analytical correctness.
