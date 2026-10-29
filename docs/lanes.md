# Lanes

A **lane** is one unit of work: a session, the branch it runs on, the worktree
that branch is checked out in, and the pull request it becomes. Phosphor shows
all four on a single sidebar row, so "where is that task, and is it green?" is
one glance, not four tools.

Related: [worktrees.md](worktrees.md) for the branch lifecycle,
[extensions.md](extensions.md) for the artifact tools a lane can call.

## Remote lanes

The sidebar lists authenticated Host lanes alongside local groups, with a machine
filter. A disconnected machine keeps its memory-only rows greyed, disabled and
labelled last known. Remote creation uses a machine and its configured repository.

Host + and New open the home composer, not a separate modal. A folder's + (New lane
in FOLDER) chooses that folder, in Desktop and the browser alike.
[Remote creation](remote-desktop.md#machine-context-and-lane-creation) owns the flow.

This Mac retains the local folder and branch flow. Selecting an unavailable Host never creates a local session.

The lane header reports the connection state. The composer and panes disable
while disconnected and recover when the Host snapshot is ready. See
[Remote Desktop](remote-desktop.md#machine-context-and-lane-creation).

Remote repository menus offer **Select all lanes** and **Select merged lanes**.
Selection follows the visible search results and includes only lanes controlled by
this client. The shared confirmation and non-blocking progress surface apply;
Stop finishes the current deletion before cancelling the remainder. Every command
rechecks connection, capabilities and control, never takes over implicitly, and
is never retried on an uncertain result. Failures are reported per lane while
other lanes continue. Shared worktrees are removed only with their last successfully
deleted user; a failed or unselected lane keeps its directory. The Host refuses
dirty worktree removal rather than discarding changes.

## The row

```
● 🚀  Give Me The Text Here
      9m · wt · give-me-the-text-here · ±2                  #418 ✓✓
```

Five parts, each owned by a different module:

| part          | source                      | note                                                            |
| ------------- | --------------------------- | --------------------------------------------------------------- |
| indicator dot | `SessionIndicator`          | derived, never stored: streaming > unseen > live > disk         |
| marker        | `lib/laneMarker.ts`         | fixed 18px slot                                                 |
| title         | `lib/sessionTitle.ts`       | live name beats scanned name                                    |
| subtitle      | `sessionSubtitle.ts`        | `·`-joined segments, branch is the only one allowed to truncate |
| PR chip       | `prChip.ts` + `PrBadge.tsx` | right-aligned trailer, **not** a subtitle segment               |

The PR chip is `ml-auto`, so it forms a scannable column down the sidebar
instead of floating after a branch name of varying width.

**The row carries no spend.** A dollar figure is something you go looking for,
not a way to choose a lane. It lives in the row's context menu ("Copy spend"),
the Home ledger and the context meter's Cost row.

`LanePrefs.prStatus` (default **on**) decides whether the chip renders at all,
and a chip only renders once there is something to say: a known PR, or a
confirmed absence on a worktree lane. Settings → Workspaces → "PR status on
lanes".

**Delegated work keeps a live lane working.** The sidebar activity treatment
and Home board include active roots and descendants from that session's
`subagent-async` snapshot, even while the parent is quiet. An explicitly
incomplete snapshot cannot establish that delegated work has settled. This
outranks merge readiness; a real human dialog still outranks running work.
A child's attention request belongs to its parent, not the "Waiting on you"
column. Snapshots are transient and are cleared with the live session. They
are not process-exit proof or authority to remove a child worktree.

## Forks and saved history

Fork, Clone and Rewind each create a new session file; pi never edits one in
place. The files look alike, so the sidebar decides by the **action** that
made them, never by their contents (shared entry ids and `parentSession`
describe ancestry, not permission to hide the source):

- **Fork and Clone** keep both rows, the source and the copy, even after their
  processes stop or the app restarts.
- **Rewind** records `old file → new file` (`AppPrefs.rewoundSessions`, keyed
  by file name so a folder rename cannot break it; written by `rewindToEntry`
  only, in the same store update that moves the session onto its new file).
  The sidebar folds the old file away while the old file is not live and a
  later version exists, following chains (A → B → C shows only C). "Exists"
  means on disk **or live**: pi writes a rewound branch with no reply yet only
  when its next turn ends, and until then the live session's placeholder row
  is the chat's one row. If the app quits before that file is written, the old
  row comes back. A pinned old file stays pinned. Deleting the successor
  brings the old row back. Nothing is deleted or written to pi's files.
- Opened some other way (palette, pin, restored session), an old version shows
  a banner, "This is the chat before a rewind. It continues in <name>", linking
  to the live version, so nobody resumes it by mistake.
- **Carrying on in an old version** makes it a chat of its own again: when a
  turn ends in it, its record is dropped and it keeps its row, beside the
  version that replaced it. Hiding it again would hide the newest work.

Rewinds made before this record existed are not folded: their duplicate rows
stay until you rename or delete one.

## Markers

An emoji pinned left of the title. Two rules, both about the **column**:

1. **The slot is fixed width and always rendered** (unless markers are off).
   A slot that collapses on an unmarked lane shifts every title and the eye
   has to re-find it on each row.
2. **The fallback is derived, not stored.** Explicit choices live in
   `AppPrefs.laneMarkers` keyed by session path; every other lane hashes its
   **branch**. Phosphor does not add fields to pi's session format.

Keying on the branch, not the title, matters: a session is named only after
its first turn **ends**, so a title-derived marker would change under you the
moment the auto-namer landed. The branch exists from the moment the worktree
does.

`LanePrefs.markers`: `auto` derives for everyone, `manual` respects choices
and derives nothing, `off` removes the column and reclaims its width. `off`
wins over explicit choices. This preference is the feature gate, available in
Settings → Workspaces → Lane markers. Turning it off also hides the picker;
existing choices are kept for when markers are enabled again.

Click a saved lane's marker (including its empty placeholder), or right-click
the row and choose **Lane marker…**, to change it. The picker bundles the
Unicode emoji catalog locally, with name/emoji search and category filtering.
**Suggested** keeps the original compact palette. Results load 120 at a time
with **Show more icons**; rendering uses the OS emoji font, so newer emoji may
not be supported by older systems. Skin-tone variations are consolidated into
base emoji. No image CDN or network access is needed.

**None** explicitly clears a lane. **Auto** removes its override and returns to
the branch-derived marker; in Manual mode this action is labelled **Default**
and leaves the lane unmarked. Escape or Cancel leaves the choice unchanged.
Explicit choices persist across reloads and mode changes.

## PR status

Desktop's `apps/desktop/electron/fs/gh-cli.ts` and the Host's
`features/git/github.ts` run read-only `gh` queries. Their listing, fallback and
check shaping share `libs/session-runtime/src/git/github.ts`.
They are **read-only by design**: no push, no create. Those are outward-facing writes
and belong behind an explicit action, which is why the `↑ no PR` chip is inert
rather than a one-click create button.

Two queries:

- `ghPrForBranch` — one branch. Used by the top-bar branch popup.
- `ghPrsForRepo`: a bounded repo listing, indexed by `headRefName`. Used by the
  sidebar. **Never fan the single-branch query across the sidebar**; that is
  8-20 subprocesses per refresh.

Both queries resolve the repository from the supplied working directory, with
no workspace or organization allowlist. They first request check details. If
that fails (including GitHub GraphQL resource limits in CI-heavy repos), they
retry once with identity and state only, keeping the same PR limit. A PR
still shows its number and state. Check, review and mergeability details are
unavailable in this fallback; it gets no green checkmark and cannot make a
Home lane ready to merge.

`stores/pullRequests.ts` is keyed by **repo path**, not session: a sidebar
group is exactly one repo, because worktrees fold into their main checkout. A
lane's PR is joined at render time through its cwd's branch.

Refresh is event-driven (window focus, disk listing change), only for
**expanded** groups, and coalesced inside `PR_STALE_MS`, so calling `refresh`
from several triggers is free.

Every `gh` failure is a normal state, not an error: not installed, not
authenticated, no GitHub remote. A failed listing returns `null`, preserves
previously known PR chips, and revokes any inferred absence. Attempts,
including failures, are throttled per repo. Nothing here toasts.

Every `gh` run goes through `piProcessEnv`, so PATH is the login shell's. A GUI
launch inherits launchd's PATH, which has no Homebrew in it, and a bare
`execFile('gh', …)` would fail in the installed app while working in dev.

**"No PR yet" is inferred, and inference needs a stricter gate than a real
chip.** The `↑ no PR` fallback renders only after a successful, complete
listing and only for a worktree with a known branch. The repo query is capped
at 100 recent PRs; a full page cannot prove absence for an older branch, so it
never produces this fallback. A failed query cannot prove absence either.
A trunk checked out directly is not "a lane", and guessing "you could open a
PR" there is wrong more often than right. A **confirmed** chip has no such
restriction.

Remote repository groups use the same PR store and chips, keyed by opaque
Host/repository identity instead of a local path. Expanded groups refresh on Host
summary changes and window focus. `github.prs` requires `workspaces.read`, resolves
only configured repository ids, and uses the Host's environment and `gh` login;
GitHub credentials never reach the client. Reads are coalesced and throttled per
repository for 60 seconds on both sides, including failures. A missing or older
Host feature leaves PR status unavailable, never inferred absent. Desktop's local
`gh` availability has no bearing on remote PRs.

### The chip is one token carrying two signals

Colour is PR state; the trailing glyph is the check/review verdict. A second
chip would double the ink on the densest line in the app, and the two are read
together anyway ("is it in, and is it green").

| variant             | meaning                                                        |
| ------------------- | -------------------------------------------------------------- |
| `open` / `approved` | open, checks green; `✓✓` once a human approved                 |
| `failing`           | checks red. The only state that earns colour at rest           |
| `pending`           | checks still running                                           |
| `blocked`           | green, but changes requested: blocked on a person, not a build |
| `conflict`          | ⚠ can't merge no matter what checks say — needs a rebase       |
| `draft`             | neutral. A draft is not a claim on your attention              |
| `merged`            | violet. The "this lane is done" signal                         |
| `closed`            | closed unmerged                                                |
| `no-pr`             | inert fallback — `↑ no PR`, no number, not a link              |

**Terminal states beat check state, and conflict beats check state too.** A
merged PR whose last run was red is still merged. A conflicting PR is
unmergeable whatever its checks say, so `conflict` outranks `failing` and
`pending`, but loses to `draft`, which stays neutral either way.

Merged gets its own colour because in the success colour "merged" and "open and
green" are indistinguishable, and those are the two states the sidebar is
scanned to tell apart. Merged is what makes PR status and bulk delete one
feature.

The chip is a `role="link"` span, not a button (the row is already a button,
and nesting one is invalid HTML), and it is out of the tab order so it does not
double the sidebar's tab stops. The row context menu's **Open pull request** is
the keyboard route.

## Naming

A local lane is named once, after its first turn ends, by a one-shot `pi -p` call
(`apps/desktop/electron/pi/session-naming.ts`). The title flows to the branch as well as the
session, so the sidebar group, the branch chip and the title agree.

Two naming passes never run for one session: `startChat` owns naming for the
chats it creates and suppresses the session store's own pass.

`titleArgs` strips everything a title does not need (tools, context files,
skills, prompt templates) so the call is not carrying ~35,000 tokens of harness
to produce a 15-token title, and always passes `--thinking off` (a title on
Haiku at the inherited `high` took 6.0s, against 2.8s off).

The model is the cheapest one in the default's provider, family and region
prefix with a known price below the default's (`pickTitleModel`, from the
cached model catalogue): Opus on the Claude CLI names with the cheapest Haiku,
`kimi-k2` with `kimi-k2-turbo`. Unpriced catalogues (local models) and an
already-cheapest default keep the default. On the Claude CLI with no catalogue
it falls back to `claude-haiku-4-5`.

The run boots fast with `--no-extensions`, so no installed package (MCP
adapter, sub-agents, web access) starts for a title. Providers can register
through extensions, so a fast boot loads the provider's own extension
(pi-claude-cli's, resolved from the installed package with `resolvePackagePaths`).
An empty extension resolution skips the fast attempt rather than passing package
display names as executable paths. If a fast boot fails, the same model runs
on a full boot, then the fallback model; a provider or model that needed the
retry is remembered until the app quits. Measured on the Claude CLI: 2.4s from
spawn to title, against 6.0s before. The run is spawned as its own process
group, and the whole group is killed when it finishes, so nothing it started
(the Claude CLI, an MCP server) outlives it.

Two constraints on the one-shot, both silent when broken:

- `pi -p` blocks until stdin reaches EOF, so it never runs through `execFile`.
  See `apps/desktop/electron/pi/print-mode.ts`.
- pi-claude-cli ≥ 0.7.0 parks its CLI process after a turn, which holds pi's
  event loop open, so a naming run would print its title and then not exit for
  ten minutes. The naming env passes `claudeOneShotEnv()`
  (`PI_CLAUDE_CLI_KEEPALIVE_MS=0`). `runPrintMode` also keeps whatever stdout
  arrived before a timeout, so a slow exit cannot throw away a finished title.

## Preferences

`LanePrefs` in `AppPrefs.lanes`, edited in Settings → Workspaces.

| pref                            | default | reaches                                  |
| ------------------------------- | ------- | ---------------------------------------- |
| `markers`                       | `auto`  | the sidebar row                          |
| `autoName`                      | `true`  | both naming passes                       |
| `nameMinWords` / `nameMaxWords` | 2 / 5   | the naming prompt                        |
| `nameMaxLength`                 | 60      | `sanitizeTitle`, after the model replies |
| `branchSlugMaxLength`           | 40      | `slugifyTitle`, so branch and folder     |

The branch **prefix** is separate, in `WorktreePrefs.branchPrefix`, beside the
switch that decides whether a chat gets a branch at all. `WorktreePrefs`
decides _whether_ a lane gets a branch; `LanePrefs` decides what it _looks
like_. Worktrees off still names sessions.

**Every number is clamped twice**, in the renderer and in main. These values
reach a prompt, a git ref and a filesystem path, and the settings UI reads back
the value it just wrote, so an out-of-range entry must be corrected locally too.
`nameMaxWords` can never fall below `nameMinWords`.

`LanePrefs` lives in its own leaf store (`stores/lanePrefs.ts`), not in
`stores/settings.ts`, which calls `window.matchMedia` at creation and would
break every non-jsdom suite that touches sessions.

## Switching lanes

Only a lane that is already live switches instantly. Every other lane has to
spawn a pi process and replay its transcript first, and a new lane has to cut a
branch before that. Two rules cover the wait.

**The click is acknowledged before the process exists.** `openDiskSession`
records the lane in `sessions.opening` synchronously, so on the same frame the
sidebar row highlights and says `Opening`, and `OpeningLane` covers the main
region with the lane's title. It is an overlay, not a fourth state of the main
region, so the previous lane keeps its React tree and a failed open leaves the
user exactly where they were. Clicking a lane whose open is already running
still activates it rather than deduping to nothing.

**Whatever finishes last does not win.** `sessions.navSeq` counts explicit
navigations — a click, a palette entry, a send. Every step that would put a
lane on screen carries the navigation it belongs to and checks it first:
`createSession` activates only for a current claim, `startChat` takes its claim
at the keystroke (not several seconds of git later) and skips re-pointing the
window at the new worktree once the claim is stale.

So sending a message to create a lane and then switching away to work in
parallel now sticks. The new lane still gets its branch, its process, its
generated name and its branch rename, in the background, and says so with a
lane notice instead of stealing the screen back twice. Clicking the notice goes
there.

**A lane that finishes off screen says so.** When pi reports a lane's run
settled (`agent_settled` after an `agent_start`, in the push handler) and that
lane is not the one on screen, `noticeLaneSettled` puts up a notice with the
first line of the final reply, or the error if the run stopped on one. A run
pi reports `aborted` says nothing: only the stop control produces one. The lane on screen never gets a notice,
even with the window in the background — its transcript already shows it.

**The wait is animated, not flashed.** `OpeningLane` fades in after a 90ms
beat, so opening a warm lane never flashes it, and fades out over the lane it
revealed (`useLingering` keeps it mounted for the exit). A transcript rises in
on every mount — a lane switch, or the skeleton giving way to history — and the
skeleton carries the Phosphor beacon instead of a spinner.

The same claim is what lets a lane **restart** in place. `restartSession`
disposes pi and resumes from the same session file, which is how a provider
change (`ModelPicker`) and a Claude account change (`moveSessionToAccount`)
take effect — disposing clears `activeSessionId`, so without this the user
dropped to the greeting screen for the whole window. On screen it is
`OpeningLane` with `reason: 'restart'`; the model chip reads
`Switching to <model>…` and is inert until it settles. A restart of a lane the
user is **not** looking at never takes the screen.

## Finding a lane

A magnifier in the workspace header opens a search field **under** that
header. It filters that group only: search is per project because the header
it hangs off is.

`laneSearch.ts` matches against the three identities the row shows: **title,
branch, and PR (number and title)**, because those are what you remember a lane
by. Both sides are lowercased with runs of non-alphanumerics collapsed to a
space, so `#412` finds `412` and `fix-and-rebase-pr-130` answers to
`fix rebase`. Terms are ANDed and order-free; matching is substring, not
subsequence, because a three-letter subsequence matches nearly every
branch-shaped string.

Four rules:

- **Enter commits, typing does not.** The rows are the navigation, and a
  per-keystroke filter makes them jump under you.
- **Closing always retracts.** The `x` and Escape both clear the filter _and_
  close the bar. A closed bar still hiding lanes is an unexplained empty
  sidebar.
- **Opening expands the group.** A filter on a collapsed group hides its own
  result.
- **Selection follows what is visible.** Select-all and shift-ranges read the
  filtered list, so a bulk delete can never take a lane the filter is hiding.

Placeholder rows stand aside while a filter is on: they have no name, branch
or PR yet. Live names are matched as well as scanned ones, so a lane renamed
mid-turn is findable under the name on screen.

## Deleting lanes

One Host lane row (`features/sessions/RemoteLaneRow`) and one menu serve every
surface: Desktop's sidebar, the browser's navigation and Lanes page, Host home and the
machine preview. `remoteLaneActions` builds the menu as a pure list (Open, Rename,
Take or Release control, Stop or Resume, Mark read, Pin, Lane marker, Copy debug
info, Copy spend, Delete, plus Open pull request when the lane has one) and
`useRemoteLaneActions` runs it; the phone's lane sheet lists the same items
without Open. The row's menu opens on right-click, the ContextMenu key or
Shift+F10, and a touch long-press; on a phone it is a bottom sheet. The row
renames inline, the sheet through a prompt. Opening a row navigates to the lane
without naming a pane, so Desktop restores that lane's pane and the browser opens
Chat. The title prefers the live session name, the Host summary, then the first
prompt. The Host, not Desktop, generates remote titles.

Pins and markers belong to the Host: a Host that announces `laneMarks` keeps
them, so every client shows the same ones
([protocol](remote-protocol.md#lane-pins-and-markers)); Desktop's older local
choices, kept under Host/lane resource keys, move to it, and rows read only the
Host's. Without `laneMarks`, Pin and Lane marker are disabled with “Update this
Host to pin and mark lanes.” A pinned Host lane shows the pin icon and sits in a
Pinned section above that Host's folders, newest first, with its folder named,
as local pinned lanes sit above local groups. Pins stay per Host: one Host's
pinned lanes never mix with another's or with local ones.

Local-only tree, fork, clone, routine and HTML export actions are omitted.
Remote Delete needs control and workspace-write capability, in Desktop and the
browser alike. A disabled action's hint names its obstacle: “Take control
first.” for a viewer, “Only while running.” for rename and spend on a stopped
lane, “Send a first message before stopping this lane.” for Stop on an open lane
with no first message (the Host refuses it), and “Not available on remote lanes
yet.” only when the Host lacks the capability. Delete uses the
same resource confirmation, keeps failures visible, and closes the lane on
success. A shared worktree gets transcript-only deletion. The Host keeps trashed
transcripts for 30 days; worktree removal and merged-branch deletion are optional.

Every sidebar session has **Delete**, including starting, running, crashed and
live-only rows whose transcript is missing. A row that is the **only session
in its own worktree** opens the lane confirm below, with worktree removal on
by default — deleting just the transcript used to leave the directory, and its
`node_modules`, on disk with nothing in the sidebar pointing at it. Every other
row (the main checkout, a shared worktree, no git info yet) gets the
session-only confirm: running work will stop, saved transcripts are trashed,
and the worktree, branch and project files are kept. A missing transcript is
not an error; other failures stay visible in the confirmation so deletion can
be retried. Pending rows do not invent a timestamp from the current time.

Concurrent opens of the same transcript share one process. Main serializes
resume and deletion by transcript path, cancels queued or hung startup opens,
and stops every matching writer (including
handles not yet adopted by the renderer), then trashes the file. Deleting a
routine-owned lane cancels its run through the scheduler first. Processes own
their child process group so nested provider processes are stopped too.
Late bootstrap responses cannot recreate deleted renderer state. On reload,
main supplies known file identities; history replay does not block access to
an unresponsive lane's Delete action.

Selection is scoped to **one group**, which is one repo. A destructive confirm
spanning two repos is how you delete the wrong branch. The Pinned list mixes
projects and is not selectable.

The checkbox replaces the indicator dot in the same gutter, so entering select
mode shifts nothing. "Select all lanes" lives in the workspace `⋯` menu.

Deleting is three resources, and all three default on. The branch default is
safe because an unmerged branch is never deleted:

1. the session transcript, to the OS Trash (recoverable): pi's `.jsonl`
   **and**, for a session recorded before provider 0.9.0, its paired Claude
   Code transcript with its `<id>/` sidecar folder (subagent transcripts,
   oversized tool results); current Claude sessions write neither. The
   bookkeeping nothing reads once the session is gone is removed with it: `pi-claude-cli`'s
   session-map entry and stored system prompt, and pi's per-cwd session folder
   once it is empty (`apps/desktop/electron/pi/session-deleter.ts`)
2. the worktree directory, gone
3. the branch, only when its work is already on the trunk

**A worktree goes only with the last session using it**
(`lanesOwningWorktree`). One directory can hold several sessions. A worktree
is offered for removal only when every session in it is being deleted, and it
is removed with the last of them — the loop is sequential, so the others'
transcripts are already in the Trash. A live session with no transcript yet
counts as a user and holds the worktree.

**A branch is deleted only when it is proven merged.** `git branch -d` tests
ancestry, and a squash merge leaves no ancestry link, so `-d` refuses every
squash-merged lane. `isBranchLanded` accepts two proofs, and `-D` runs only
when one holds:

- **The squash test** (`isBranchMerged`): `git cherry` against a commit built
  from the branch's tree.
- **A merged PR** (`landedViaPullRequest`, via `gh`): the squash test misses a
  lane whose history was rewritten after merging, or whose squash was cut on
  a newer trunk. It proved 2 of 26 merged lanes on one install. A merged PR
  from the branch counts only if the local tip is its head, sits behind it, or
  has the same tree, so a reused branch name or work added after the merge
  never passes. Without `gh`, or offline, this proof answers no.

Anything unproven is kept and reported; the transcript still goes.

**Remote branch deletion is not offered.** A bulk flow is the worst place to
introduce the least reversible operation.

### Lost-work acknowledgement

Running turns are included, not refused. A turn in progress, uncommitted
changes, unpushed commits, or an open PR raises **one** acknowledgement for the
whole selection. Confirming stops those turns before deleting their lanes.
A disposal failure is reported per lane and does not strand the progress loop.

### Ordering, and why it is that way

Per lane: dispose the live session, remove the worktree, then delete the
transcript. Worktree removal is the step that fails in practice (a terminal
cwd'd into it, a dirty tree), and failing first leaves the lane whole and still
in the sidebar. The other order leaves a transcript in the Trash and a
directory on disk.

The loop is **sequential**: each lane disposes a subprocess and runs git, and N
at once is how a worktree gets removed while its own pi is still writing.
Cancellation is checked between lanes only.

### Deletion stays out of the way

After the destructive confirmation, progress moves to a compact notification
at the top left. It has no backdrop, so the rest of Phosphor remains usable.
The lanes owned by the delete loop are disabled until they are removed, fail,
or are skipped after Stop; other lanes and the active workspace remain usable.
A second bulk delete cannot start while the first one is running.

The notification expands to show every per-lane outcome. That detail matters:
a worktree that would not remove is the common case, and that lane remains in
the sidebar. When processing finishes, the panel collapses to its summary,
then fades away.

## Reclaiming lanes automatically

A merged PR finishes code, not a conversation. Automatic cleanup requires an
explicit **Finish conversation…** decision from the sidebar context menu for
**every** transcript in the checkout. Suspend its live sessions first. **Reopen
conversation** or resuming the lane clears that decision. Unknown, legacy,
paused and otherwise unfinished conversations remain protected across restarts.

Settings → Advanced → **Maintenance** runs a sweep with two switches, because
measuring and deleting are different risks:

- **Reclaim dead lanes** (on) sweeps hourly and **reports**. It never deletes.
- **Delete automatically** (off) lets a sweep act.

**Reclaim now** deletes without flipping the pref and cannot delete more than a
sweep would; both run the same policy. Scan, **Reclaim now** and the scheduled
sweep all cover every workspace in the recent-workspace list, one after
another, and the section lists what each one could free. (The button once
covered only the active workspace, so one click freed one repo and silently
left the rest.)

All conditions must hold before a worktree is a candidate
(`apps/desktop/electron/maintenance/policy.ts`): not the main checkout, on a
branch, verifiably clean, not protected by a live session, recent workspace or
routine, not Git-locked or pinned, **all conversations explicitly finished**,
**proven landed**, and past `minAgeHours`. Empty or unreadable histories do not
count as completed. Git ancestry can prove a research branch landed, but never
proves its conversation finished. Existing opt-in preferences and **Reclaim
now** do not bypass completion. Every rejection is reported with its reason.
The PR proof runs only for clean lanes Git could not prove, four `gh` calls at
a time.

Before each removal, main takes the same workspace gate as Desktop session
admission and rechecks eligibility, current ownership/protection, completion,
activity, locks and dirty state. A queued resume invalidates completion before
waiting for the gate. These ownership protections are process-local; an external
pi process is not registered here. Git worktree locks remain a protection across
processes and are never forced through.

Manual **Remove worktree** is a separate explicit action: it previews affected
conversations and requires confirmation, refuses live ownership and locks, and
requires a second acknowledgment to discard dirty files. History is retained.

A recent workspace that is not a git repository (a "No folder" sandbox) is
skipped, not reported as a sweep error.

The grace period starts from the later of explicit completion and real activity:
actual transcript-file modification times, persisted session-open/seen times,
and checkout/session-directory timestamps. Appending a transcript need not
change its directory mtime, so directory timestamps alone are not sufficient.

Before removal, main saves repository, checkout path, branch, exact tip commit,
related conversation IDs, completion/activity timestamps, eligibility reason and
attempt outcome in `userData/session-maintenance.json`. A Git ref under
`refs/phosphor/recovery/` keeps that tip reachable even after branch deletion.
A crash after recording intent leaves a `pending` audit record, not lost identity.
These records and refs are retained; cleanup does not age them out.

Sidebar discovery also reads retained transcript headers under each repo's
`.phosphor/worktrees/`, independent of surviving Git registrations, plus saved
removal records for other checkout locations. Removed checkouts show **worktree
removed**; clicking one opens a read-only saved conversation, without restoring
files, starting pi, changing completion or rewriting the transcript's cwd. Failed
reads offer Retry. The saved active context includes pi's compaction summaries;
the session tree remains available separately.

**Restore worktree…** (the row's context menu, or the reader's footer, which
also resumes the conversation afterwards) opens a chooser
(`maintenance/recovery.ts`). Every option recreates the **original path**, so
the transcript and the Claude provider's cwd-keyed ledger stay untouched; moving
a conversation to a new folder would mean rewriting both. Options, most exact
first, and only those that apply:

- **Restore saved commit**: the exact saved commit, detached to avoid
  overwriting a reused branch. Needs a removal record.
- **Check out `<branch>`**: one branch, local or on origin only, that matches
  the checkout: the branch in a stale Git registration or the removal record,
  else the single branch named `<folder>` or `…/<folder>`, with the configured
  prefix breaking a tie. Several candidates mean no guess. Trunk and branches
  checked out elsewhere are never offered.
- **New branch from `<trunk>`**: `<prefix><folder>` (suffixed when taken) cut
  from the start point new lanes use. It does not bring back the lane's earlier
  work, and the chooser says so.

The chooser lists the files the conversation's `edit`/`write` calls changed in
the old checkout, or states that there were none. Shell commands are not
checked, so an empty list is a hint, not proof. Main recomputes the plan inside
the workspace gate when an option is picked, refuses an existing path, a live
session, a locked registration and paths outside `.phosphor/worktrees/`, and
drops a stale Git registration of that same path first (other stale entries
are left alone). Dependencies must be
reinstalled. Phosphor never picks a replacement silently.

Sizes come from `du`, which Windows lacks; an unmeasured size reports "unknown"
and the policy never depends on the number. The scheduler is a plain interval
in main with a 5-minute warmup and a 15-minute floor, one sweep at a time.
