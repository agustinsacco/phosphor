# Remote Desktop

Desktop is a client of an enrolled Host. Start with [remote access](remote-access.md)
for setup, the end-to-end flow and trust boundaries. This contract owns main-process
routing and machine selection. Individual panes keep their own UI contracts.

## Desktop Host connections

Main keeps one authenticated socket per up Host with a bare HTTPS `.ts.net`
origin, up to 32 sockets. It follows account and machine-directory changes.
Sign-out or account change closes sockets and clears remote memory. Down Hosts
retain their last-known lane summaries in memory only. Removing a Host drops
its cache. Endpoint changes close the old socket before opening another.

Client ids live in a separate main-only electron-store, one per account with
at most eight entries. An unknown or revoked client refusal permits one
replacement registration per user per app run. Only sign-out or switching
accounts resets that budget, not a forbidden refusal or a directory refresh.
Grants are cached only until their renewal time. Main verifies each Host's
challenge proof with its enrolled public key before trusting its ready frame. Connections renew grants and send text keepalives.
Transient failures reconnect with bounded backoff. Forbidden access and an
unsupported protocol stop retries; a wrong-machine proof stops until the
machine directory changes. Oversize closes query receipts rather than resend
commands. Other reconnects resend unchanged commands under 60 seconds, then
ask receipt status. Replay waits for queue space in original order, rechecking
that age rule on each retry. New sends answer `not-connected` until replay drains.
Unknown means the action's outcome remains uncertain.
Local `not-sent` results (`too-large`, `too-many-pending`, `not-connected` or
`closed`) never write or queue a command. `not-connected` is transient; callers
may try a fresh action once ready. `closed` means no automatic retry.

`hosts:snapshot` exposes `down`, `no-address`, `connecting`, `ready`, `reconnecting`,
`wrong-machine`, `unsupported` and `signed-out` states. `hosts:changed` is a
250 ms debounced refetch signal. Each snapshot includes an opaque main-owned
`connectionToken` that changes on reconnect or connection replacement, even when
intermediate states are coalesced. Machine reads use it to reject stale replies. Controllers expose only a label, connection
status and whether they are this Desktop, never a client or user id. Repositories,
lane summaries, cursors, the last 50 attention events and open lane streams stay
in memory. No transcript is written to the client's disk. Remote lane access
requires `sessions.read` in the Host's authenticated `ready` frame; mutations
also require `sessions.control`.

`hosts:openLane` returns one opaque `remote-<16 hex>` handle per lane per window,
with at most 64 handles per window. Its workspace key is
`host:<hostId>/<repositoryId>`, never a local path. Opening marks the lane read.
`hosts:createLane`, `hosts:stopLane`, `hosts:resumeLane`, `hosts:takeControl` and
`hosts:markRead` send bounded, validated Host commands. Taking control is always
explicit. Handles are private to their window and disappear on window close,
sign-out, account change or Host removal. Down Hosts retain memory-only views.

Main routes remote `pi:command`, `pi:extensionUiResponse` and
`pi:disposeSession` without consulting the local pi registry. The allowlist is
`electron/hosts/lane-ops.ts`. Receipts become pi responses; controller rejections
name the machine and controller. Unknown outcomes tell the user to check the lane
before retrying. Unanswered commands expire after 60 seconds as unknown, never
as a fresh retry. Local pi routing is unchanged.

Remote snapshots and reset snapshots replace main's in-memory lane projection.
Main sends `resync` on the handle's usual pi event channel. The renderer obtains
state and messages through the existing hydrate path. Until the messages reply,
main holds live pushes and serves the frozen snapshot. After that reply it sends
the snapshot's pending events and UI, open dialogs, then held pushes, in order.
The hold is bounded by the stream event and byte limits; overflow starts a new
resync. Without a messages query it flushes after ten seconds. Live pi events
otherwise pass through unchanged. Reconnect subscriptions carry the last cursor;
a new epoch or reset starts hydration again. Dialog resolution resyncs viewers
without the answered dialog.

Attention publishes `hosts:attention` and a machine-titled OS notification for
lanes not focused in any focused window. Notifications are deduplicated in
bounded memory. Clicking focuses a window and sends `hosts:openLaneRequested`.

<!-- pending: K -->

`hosts:setFocusedLane` tracks each window's active remote lane, or null for a
local lane. Read counters come from the Host and clear unread across clients.

`IPC_SCOPE` classifies every invoke channel as app-local or machine-scoped.
Unrouted machine channels reject opaque remote workspace keys and remote handles,
including nested options, with “Not available on remote lanes yet.” They never
fall through to this machine's filesystem or subprocesses.

## Machine context and lane creation

Remote creation uses machines announcing `sessions.control` and selects one of
that machine's configured repositories, not a local folder.

<!-- pending: L -->

An unavailable selection
stays selected and disabled. Failure never starts a local session instead.

Remote header and pane chips report Connected, Reconnecting or Down from the
connection snapshot. Directory-down Hosts retain greyed, disabled lanes labelled
"last known". The composer and panes show "Machine not connected. Wait for
reconnection." while disconnected, then recover from snapshots without reload.

Machines detail keeps Readiness and adds On this machine: lanes, skills, routines
and artifacts, only for announced capabilities. Counts that fail to load say
Unavailable, not zero. Links open the machine-filtered page. This Mac keeps its
existing detail sections and uses its own lanes, Skills, Routines and Artifacts pages.

Skills follows the sidebar machine selection and has a switcher for This Mac plus
machines announcing `skills.read`. Remote skills remain read-only. Machine-wide
skills and model/provider catalogues do not require an open lane. Main validates
results, gates on `skills.read` before and after the call, and rejects replies
from replaced connections or incarnations. Page stores ignore late replies after
selection or connection changes. Remote machines show models and providers on
Skills; This Mac shows them in Settings.

## Remote read panes

Remote Files and Changes require `workspaces.read` in the Host's ready frame.
Files lists tracked and untracked non-ignored paths. Controllers with
`workspaces.write` and `sessions.control` can edit text, create files and folders,
rename, copy, move and trash entries inside the lane. Saves compare the SHA-256
revision read by the editor; conflicts preserve edits and require a refresh.
Uncertain saves preserve edits and are never retried automatically.
Unsaved drafts stay in renderer memory per lane, survive lane switches, and clear
on discard, successful save or lane forget.
Changes shows git status and an inline read-only diff against HEAD. Binary files
and oversized text use placeholders. Remote text uses in-memory Monaco models, never local preview protocols or
filesystem watchers. They refresh
on focused lane summary changes (including turn end), reconnects and manual refresh.
Streamed text does not reload the pane. Added and untracked files use an empty
original. If HEAD cannot be read, its placeholder does not discard current text.

Main routes only `fs:listFiles`, `fs:readFile`, `git:statusMap`, `git:showFileAt`,
`skills:list` and `skills:readFile` to the read features, and only when the call
names a `host:` workspace. A call with no workspace, such as the global model catalogue,
stays local even while a remote lane is focused.
The live chat picker keeps the lane's full pi model list through `lane.models`,
requiring `sessions.read`. Stopped lanes do not fall back to a machine catalogue.
Skills requires `skills.read`. Remote Skills shows the installed list
and SKILL.md read-only, with no export, upload, discovery installs or mutations.
Unsupported panes retain the not-available state. Remote attachments require a
ready Host with `workspaces.write` and `sessions.control` and the current controller.
Main uploads document bytes with fenced begin/chunk/commit receipts before sending
the prompt. Upload failure or uncertainty never sends the prompt and never resends
a chunk. The committed Host path is the sole attachment-path exception: it appears
in the same `<attached-files>` prompt block as a local document, not in a new UI
surface. Local file paths are never sent to Host pi. See [Host attachments](host.md#attachments)
for limits, quota, storage and cleanup.
The six `fs:` mutation channels route to fenced Host commands, not local I/O.

Workspace reads resolve through the window's focused open lane. The opaque
workspace key must match that lane, so two worktrees in one repository are not
chosen by repository id alone. Without a focused lane, workspace reads fail closed. Machine-wide skills use
`host:<hostId>/machine` keys and the same read-only projection, without a lane.
File and skill keys contain no Host filesystem root. Main validates params and
parses every feature result with the shared bounded parsers, and rechecks the
connection and capability after each reply. Errors expose only fixed text.

## Remote artifacts

The lane's Artifacts pane requires `artifacts.read` in the Host's ready frame.
Main uses the lane handle, never a session file path, to fetch metadata and each
current-branch version. A call caps total content at 8 MiB and each version at
2 MiB, with at most 1,000 version reads per call. Invalid replies, changed
connections, revoked capability or a changed
focused lane fail closed. The renderer serializes and coalesces metadata reads per lane, discarding replies
after navigation, detach or connection changes. It refreshes on open, reconnect,
new stream epochs and artifact-tool completion; empty replies replace cached
artifacts. The top-bar entry remains visible for a ready Host with
`artifacts.read` even when the lane has no artifacts yet.

The global Artifacts library includes local artifacts and artifacts from ready
Hosts announcing `artifacts.read`, tagged with the machine label. Remote library
keys name opaque lane/slug resources, not Host session ids or filesystem paths.
A failing machine is absent from the listing; local rows and other machines still load.
Stored remote rows open read-only in the library; live rows can open their lane.
Removed lanes are excluded because no admitted lane authorizes their read.
Local deleted-session retention is unchanged. Host indexes and blobs stay on
the Host; Desktop holds remote contents in memory only.

HTML staging remains local through `phosphor-artifact://`. Its sandbox never
uses `allow-same-origin`, and its policy grants no network access.

## Install a Host over SSH

The Add a machine dialog guides Before you start → Install → Online → Providers.
It checks the signed-in Phosphor account and reads Tailscale status on this computer.
A failed check offers fixed recovery guidance and manual installation remains available.
The Online step follows the enrolled directory entry, distinguishes first connection
from offline, and keeps recovery commands in the collapsed Stuck? disclosure. Once online,
it advances to Providers after a short pause. Back preserves a running SSH installation,
including its target, repository, progress and fingerprint approval. Providers
reads the Host's provider readiness and opens the machine page's Readiness section
for Sign in. The manual fallback is `phosphor providers login PROVIDER` over SSH.
Provider credentials stay on the Host.

Optional Tailscale peer suggestions are off by default and persisted in Desktop
preferences. Main runs only `tailscale status --json`, without a shell, with a five
second deadline, forced termination and 1 MiB output limit. A failed status read
clears suggestions without reverting a successfully saved discovery preference. Only fixed status codes and, when opted in,
peer DNS names, OS and online flags reach the renderer. No addresses, keys, tags,
user identities or command output are logged or exposed. Suggestions show online
peers excluding enrolled endpoint hostnames, not machine labels. Picking a suggestion
only fills the SSH target. It does not connect, enroll, trust or scan a peer.
Install remains an explicit action with the existing fingerprint approval checks.
While an SSH installation is running or awaiting approval, suggestions cannot replace
its target; return to Install to resume it. Idle installations can use another suggestion.

Machines > Add a machine > Install over SSH uses the system `ssh` in Desktop
main, only for installation and repair. Enter `user@host` or an SSH config alias.
Desktop uses your agent, keys and known_hosts. It never requests a password or
accepts an unknown host key. Agent and X11 forwarding and configured tunnels are
disabled. If connection fails, run the displayed `ssh TARGET`
command once in a terminal, then try again.

Optionally enter a repository relative to the remote home, such as `src/project`.
It must already exist. Only letters, digits, dots, underscores, hyphens and path
separators are allowed, with no `.` or `..` segments or leading hyphens. Without
it, setup uses the existing config or the remote working directory's git root.
If neither exists, choose a repository and retry. pi and the installer prerequisites
must already be installed on the machine ([host.md](host.md#setup)).

Desktop pipes its bundled signed-manifest installer to `sh -s --`, using the
installer's latest-release default, then runs non-interactive setup, login and
user service installation as separate SSH processes. Login stays running while
you approve the code in the same dialog as manual enrollment. Desktop looks up
the code from login stdout only and refuses a fingerprint mismatch. Banners and
stderr cannot supply the enrollment. Desktop discards login stdout through a fresh
per-job sentinel and fails the step if that sentinel is missing. Both fingerprints
appear inline.
The Host saves its own identity after approval. The dialog waits for service
installation to finish before offering Close or View machine. Cancel remains
available while waiting, and SSH failures stay visible. SSH is never the lane
transport.

One install runs per target, with at most eight jobs. Install steps time out after
ten minutes; login ends when its code expires, with a ten-minute upper bound.
Cancel or closing the dialog kills the local SSH process group. It does not roll
back a completed remote step or revoke an approved machine. Retry is explicit.
Failures show fixed guidance and a collapsible, bounded last 20 lines of remote
output. Output, targets, codes and fingerprints stay out of Desktop logs.

Terminal capability, controller input, reconnects and privacy are owned by
[terminal.md](terminal.md#host-terminals). Native release resources and wire bounds
are owned by [host.md](host.md#host-terminals).

## Sidebar machine selection

The sidebar machine menu is available whenever remote access is signed in,
even before a Host is enrolled. This Mac is the default when a window opens and survives hiding the sidebar;
selection is not persisted. Add machine opens the existing Machines add flow.
All machines lists local repository groups first, followed by labelled Hosts.

Connected Hosts show repository-grouped lanes with running, new and needs-you
signals from their existing summaries (`working`, `attention > read`, and
`needs-input` or `failed`). Local activity uses streaming chat state, unseen
session markers/unread counts, pending extension dialogs and chat errors.
The button summarizes only machines other than the selected one.

Reconnecting uses an amber pulsing status dot. Down machines show a grey dot,
the directory's last-seen age, and last-known groups with disabled lane and
creation actions. Setting up uses blue and an explicit empty state. A connected
Host with an empty repository shows “No lanes yet” and its capability-gated +.
Remote actions retain the fixed reconnection/unavailable hints and main's
capability, readiness and stale-connection checks. Creating a remote lane never
falls back to local creation.

The home composer follows the sidebar machine selection (All machines uses This
Mac). A picker override lasts until the next sidebar selection change. This target
is window-local renderer state, never persisted. Host-targeted folder, model and
thinking chips use that machine's repositories and signed-in provider catalogue.
There is no branch chip when the snapshot supplies no branch information. The
model prefers the last usable choice on that Host, then a usable Desktop default,
then the first model of the first ready provider. The effective choice is visible.

<!-- pending: L -->

Remote row actions, title precedence, pins, markers and delete confirmations are
owned by [Lanes](lanes.md#remote-lanes). Authentication remedies open that machine's
Readiness page, never a local terminal. A ready Host without a usable signed-in
model offers Sign in on that machine, distinct from a disconnected refusal.
Retry appears only for the last confirmed failed turn while idle and controlled.

Skills, Routines and Artifacts follow the sidebar machine. A page picker overrides
that selection until the next sidebar change. All machines defaults Skills and
Routines to This Mac, while Artifacts shows every machine. A down or incapable
selected Host shows its refusal, not local data. Page targets stay in this window
and are never persisted. In-lane panes still belong to their lane.

Folder browse/add/remove is owned by [remote workspace context](ui-shell.md#remote-workspace-context)
and [Host repository management](host.md#repository-management-and-lane-deletion).

## Provider sign-in

Machines Readiness opens a private Host login terminal for a provider that is
not signed in. The Host runs the CLI's fixed provider login path, not a program
chosen by Desktop. The machine-scoped command uses owner-only receipts and needs
`terminal` plus `sessions.control`, rechecked before execution. Only the creating
client can watch or operate this terminal, including after reconnect. Input is
sequenced and never replayed after uncertainty. Login content and credentials
are not logged, persisted by Phosphor or sent to control. PTYs are limited to
one per provider and two per Host; they end on exit, grant/capability loss,
shutdown, or ten disconnected minutes. See [provider login](host.md#providers-login).

## Remote lane surface isolation

The lane artifact pane reads only its explicit session id. An empty Host reply
clears that lane's cached artifacts; switching back restores the Mac lane's own
artifacts, not a global selection. Workspace writes from a remote artifact are
disabled; [remote surface gaps](future-features.md#remote-surface-gaps) owns this limitation. Save and PDF export explicitly
target This Mac. The top-bar artifact count belongs to the active lane.

Remote slash commands come from the lane, and file mentions search its Host file
list. Thinking levels derive from the lane model. Local rules/MCP and Swarm menus
are hidden. Shell shortcuts, queued-message removal, rewind and fork are refused
with the fixed unavailable hint. Continue waits for the remote receipt and echo;
it never inserts an optimistic duplicate. Error cards do not inspect This Mac's
AWS profile. Lane and machine switches reset visible selections or show loading
or refusal while the new target loads.

## Machine repository browsing and remote file targets

With a Host selected and no lane open, Files lists that machine's configured
repositories and previews their files read-only. `hosts:repositoryFiles` and
`hosts:repositoryFile` require ready `workspaces.read`, a configured repository
id, and the same connection and generation before and after each read. They
never fall back to This Mac. File wire reads name exactly one lane or repository;
writes remain controller-only and lane-scoped.

Remote file trees use the local explorer's row and icon toolbar components.
Empty trees say "No files yet"; Changes has its own empty state. A failed git
status does not hide files, including in non-git configured folders. Tree views
refuse more than 50,000 derived nodes or more than 64 nested components rather
than silently truncating the tree. Remote content and editor state stay in memory.
File models and workspace keys include the lane identity, not just its repository.
Switching targets resets previews and cancels stale reads. Machine browse state
is reset on a machine switch.

Tool path chips and markdown links carry their originating chat session through
`SessionFileTarget`. An absolute Host path opens only when it is inside that
lane's cwd; a relative path must pass the Host path grammar. Finder and chat
links share the same remote open/reveal API, including line jumps. Host-namespaced
reads never fall back to the Mac filesystem. A remote link without its originating
session fails closed. Explicit local catalogue reads stay local, independent of
which lane is focused.

The Host owns lane naming and lifecycle; see [Host lifecycle](host.md#remote-lane-names-and-lifecycle).

<!-- pending: J -->

Desktop retains full model metadata per open lane in memory. Without it, a
stopped lane's chip shows its last reported model id, never another lane's model
name. Release control uses `hosts:releaseControl` and the fenced `control.release`
operation. [HL1 and HL2](known-issues.md#host-lanes) describe current persistence defects.

Folder browse/add/remove and lane delete use typed main IPC and Host receipts.
Folder selection is confined to the Host user's home; no client chooses an
executable or environment. Add/remove can be disabled by Host config. At least
one configured folder must remain. Lane deletion stops the Host process, trashes
the transcript on the Host and optionally removes an unshared worktree and a
proven-merged branch. These actions never delete This Mac's files. See
[host.md](host.md#repository-management-and-lane-deletion) for the bounds and
partial-failure policy.

Directory heartbeat changes do not replace a connecting socket. Main logs fixed
replacement reasons (removed, down, endpoint, identity); connection closure logs
its numeric close code. No prompt, title, file content or folder path is logged
by these operations.
