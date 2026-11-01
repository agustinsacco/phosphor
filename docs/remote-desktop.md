# Remote Desktop

Desktop is a client of an enrolled Host. Start with [remote access](remote-access.md)
for setup, the end-to-end flow and trust boundaries. This contract owns main-process
routing and machine selection. Individual panes keep their own UI contracts.

## Desktop Host connections

The transport, proof barrier, lane projection and remote-lane delivery core live
in `libs/host-client/src/`, shared browser-safe source rather than a second client
implementation. `apps/desktop/electron/hosts/` retains compatibility facades and
Desktop-owned account, window and Node-crypto adapters. The proof barrier releases
no ready state or queued data until identity verification succeeds on the same
still-open transport. Authentication error frames preserve close-code recovery;
authentication timeouts and closing sockets cannot publish a late ready state.

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

`hosts:reconnect` re-reads the directory, then replaces one present Host's
connection (logged as reason `requested`). `hosts:traffic` pages main's
memory-only traffic log after a cursor: up to 2000 metadata lines covering Host
frames in both directions, control calls and connection changes, never frame
payloads ([Machines debug log](ui-shell.md#health-check-and-debug-log)). The
log is recorded through an optional connection port that cannot fail a send or
a receive.

`hosts:openLane` returns one opaque `remote-<16 hex>` handle per lane per window,
with at most 64 handles per window. Its workspace key is
`host:<hostId>/lane:<laneId>`, never a local path. Lane-qualified keys keep
different worktrees in the same repository distinct. Opening marks the lane read.
`hosts:createLane`, `hosts:stopLane`, `hosts:resumeLane`, `hosts:takeControl` and
`hosts:markRead` send bounded, validated Host commands. Taking control is always
explicit. Handles are private to their window and disappear on window close,
sign-out, account change or Host removal. Down Hosts retain memory-only views.

Main routes remote `pi:command`, `pi:extensionUiResponse` and
`pi:disposeSession` without consulting the local pi registry. The allowlist is
`libs/host-client/src/lane-ops.ts`, re-exported by the Desktop facade. Receipts become pi responses; controller rejections
name the machine and controller. A `prompt` rejected `lane-stopped` sends
`lane.resume` and, once that is done, the prompt again (`sendToLane`); a failed
resume is the answer. Any other `lane-stopped` rejection tells the user to press
Resume. Unknown outcomes tell the user to check the lane
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

An OS notification click targets one window only. In-app cards, attention toasts
and notification clicks share [notice navigation](chat.md#notice-navigation).

`hosts:setFocusedLane` tracks each window's active remote lane, or null for a
local lane. Read counters come from the Host and clear unread across clients.

`IPC_SCOPE` classifies every invoke channel as app-local or machine-scoped.
`electron/ipc/machine-resource-args.ts` declares, for every machine channel, the
arguments that name a local resource: positional paths and handles, named option
fields such as `pi:createSession`'s `workspacePath`, `sessionPath` and `forkFrom`,
and each item of a path array. Each declaration is typed against the channel's
arguments, so a machine channel without one, or a selector its types do not
allow, does not compile. Once the remote routers decline a call, a selected
position holding a `host:` workspace key or a `remote-<16 hex>` handle fails with
“Not available on remote lanes yet.” So does one that is not a string where its
type requires one, a malformed options object or array, or an array over 4096
items. Such a call never falls through to this machine's filesystem or
subprocesses. Nothing else is inspected: file content, terminal input, commit
messages, routine instructions, labels, HTML, configs and settings patches reach
the local handler unchanged. The four `pi:` channels main routes by handle
(`pi:command`, `pi:extensionUiResponse`, `pi:disposeSession`,
`pi:listLiveSessions`) are declared exempt.

### Attention receipt enrichment

Main requests [the lane receipt call](remote-protocol.md#lane-receipt-call) only
for unfocused `finished`, `failed` and `routine-finished` attention. It waits at
most two seconds for enrichment. Missing support, refusal, invalid data or timeout
leaves the plain card. A receipt is used only when its outcome matches the event
and `settledAt` is within 30 seconds of the attention time. A newer attention
event for that lane supersedes a pending publication. Replies from replaced
connections, removed lanes or connections without `sessions.read` are discarded.

The Host reports provider-error completions as failed, not finished.
[Lane notices](chat.md#lane-notices) own card contents and fact meanings. Host OS
notification bodies carry facts only, or a fixed status when facts are unavailable;
no answer excerpt is included. This Mac completion notices remain in-app only.

## Machine context and lane creation

Remote creation uses machines announcing `sessions.control` and selects one of
that machine's configured repositories, not a local folder.

The repository + opens that Host's home composer with the repository selected.
Sidebar New under a Host filter uses its last-used available repository, or the
first configured one. There is no New-lane modal. Submitting creates and opens
the lane, acquires control if needed, then sends the prompt. Only a confirmed
prompt clears the draft; failure keeps it.

Isolation follows This Mac's worktree preference and branch-naming rule. Generated
Host branches trim only the slug to fit the 100-character flattened limit; an
oversized prefix fails before sending. Desktop requests `worktree.fresh: true`,
trying the base name once, then retrying only confirmed `branch-exists` refusals
with `-2` through `-5`. Exhaustion shows “Couldn't find a free branch name on <machine>.” and keeps the
draft. Unknown outcomes never trigger a branch retry. The Host's new-only guarantee
and older-Host compatibility are in [Creating lanes](host.md#creating-lanes).

A creation that did not succeed crosses IPC as a fixed code, never the Host's text
(`createFailureText` in `libs/host-client/src/lane-ops.ts`). For a Host refusal, a
failed receipt or a frame that was never sent, the composer says the machine
couldn't start the lane; a `too-many-requests` refusal says it is at its lane limit
or too busy. An unknown receipt, a dropped connection, or a request main refuses
before or after sending (missing control capability, an invalid frame, a changed
connection) says the Host could not confirm it. Every case keeps the draft.

An unavailable selection stays selected and disabled. Failure never starts a local session instead.

Remote header and pane chips report Connected, Connecting (first attempt),
Reconnecting or Down from the connection snapshot. Directory-down Hosts retain
greyed, disabled lanes labelled "last known". While a Host connects or
reconnects, the composer is locked with its draft under a spinner note naming
the machine, and the header holds its control buttons. A down Host's composer
and panes show "Machine not connected. Wait for reconnection." Both recover
from snapshots without reload.

Machines detail keeps Readiness and adds On this machine: lanes, skills, routines
and artifacts, only for announced capabilities. Counts that fail to load say
Unavailable, not zero. Links open the machine-filtered page. This Mac keeps its
existing detail sections and uses its own lanes, Skills, Routines and Artifacts pages.

Skills follows the sidebar machine selection and has a switcher for This Mac plus
machines announcing `skills.read`. Remote skills are not edited in place; they can
be shared ([Skill sharing](#skill-sharing)). Machine-wide
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

Main routes lane-keyed `fs:listFiles`, `fs:readFile`, `git:statusMap`, `git:showFileAt`,
`skills:list` and `skills:readFile` to the read features only when the call
names a `host:` workspace. A call with no workspace, such as the global model catalogue,
stays local even while a remote lane is focused.
Repository-wide `gh:prsForRepo` instead uses an opaque `host:<id>/repo:<repositoryId>`
key and requires ready `workspaces.read`, not an active lane or control. The Host
runs `gh` in its configured repository with its own credentials; the client's
local `gh` is not required. Remote rows reuse the PR/check-state chips and safe
links described in [Lanes](lanes.md).
The live chat picker keeps the lane's full pi model list through `lane.models`,
requiring `sessions.read`. Stopped lanes do not fall back to a machine catalogue.
Skills requires `skills.read`. Remote Skills shows the installed list
and SKILL.md read-only, with no export, upload, discovery installs or in-place edits.

### Skill sharing

A skill's detail has **Share** on every machine's Skills page. It clones the whole
skill folder into another machine's global skills folder (`<agent dir>/skills/<name>`);
the two copies are not linked afterwards. A line under the skill's path says which
other machines already have a global skill of that name, from `pi:commands` for
This Mac and `hosts:skills` for each ready Host. Offline or unreadable machines are
never reported as lacking it.

The popover lists This Mac (in Desktop) and each Host announcing `skills.read`.
A Host takes a copy only while ready with `machine.configure`; otherwise its row
says Not connected, links to its settings to enable configuration access, or asks
for a Host update. A copy shows two steps: the read from the source (with file
count and size) and the write on the target. If the target already has the name in
its skills folder, the popover asks before **Replace**, which deletes that folder
and writes the bundle already read. A same-named skill that the target loads from
anywhere else (a package, a settings path, a link) blocks the copy outright,
because replacing the folder would not replace it.

`hosts:skillExport` and `hosts:skillInstall` carry one bounded bundle
(`libs/shared/src/host-protocol-skill-share.ts`: 200 files, 2 MiB per file, 4 MiB
in total, base64) through the renderer, so Desktop and the browser share the flow.
`'local'` is This Mac: export accepts only a folder the last `skills:list` reported,
and install probes pi's global commands without touching the Skills page's
known-folder registry. Any other machine is a Host id, routed through
`libs/host-client/src/skill-share.ts`, which gates the read on `skills.read` and
the write on `machine.configure` before and after the call. Bundles never carry
symbolic links, dot folders, `node_modules` or provenance sidecars. Writes stage
in a private folder and rename into place
(`libs/session-runtime/src/skills/share-bundle.ts`), so a target never holds half
a skill. An unconfirmed write is reported, never retried. The browser has no
`'local'`.
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

## Add a machine

Machines > Add a machine guides Before you start → Install → Online → Providers.
Desktop does not install over SSH or suggest Tailscale peers.

**Before you start** checks the signed-in Phosphor account and reads local
Tailscale readiness. It states what the new machine needs: Tailscale signed in on
your tailnet, and pi; the install command does the rest. Both computers need
MagicDNS and HTTPS certificates enabled.
Checks are read-only. Fixed recovery guidance and Check again help with failures;
if the CLI is unavailable, verify Tailscale manually and continue.

Main runs only `tailscale status --json`, without a shell, with a five-second
deadline, forced termination and 1 MiB output limit. A packaged app inherits
launchd's minimal PATH, so main looks for the executable in the inherited PATH,
the login-shell PATH and fixed install locations (on macOS the Tailscale.app
bundle, `/usr/local/bin` and `/opt/homebrew/bin`). It runs only an absolute path
to an existing, executable regular file. Not found reads as not installed; a
found file that fails to start reads as a failed check. Only a fixed readiness
code reaches the renderer, never peer names, addresses, keys, identities or
command output. There is no peer discovery preference or suggestion list.

**Install** shows a copyable command to run in a terminal on the other machine:

```sh
curl -fsSL https://github.com/agustinsacco/Phosphor/releases/download/host-latest/install.sh | sh && export PATH="$HOME/.local/bin:$PATH" && phosphor setup
```

The export makes `phosphor` available in that terminal. The installer adds a
marked PATH block for future supported shell sessions; set
`PHOSPHOR_NO_MODIFY_PATH=1` in its environment to opt out. See
[Host installation](host.md#install-from-a-release) for startup-file safety and
[guided setup](host.md#setup) for resumable config, enrollment, service and
Tailscale setup. No repository is required to bring the machine online.

Choose **I have a code**, enter the code printed by setup, compare the displayed
fingerprint with the Host's terminal and approve with an editable machine label.
Codes expire after ten minutes. Approval enrolls the machine; it is not an
execution grant.

**Online** follows the enrolled directory entry and the live connection through
one reachability rule (`machineReachability`), shared with the machine page and
the sidebar. Enrollment alone does not prove reachability. The rule checks, in
order: a Host never seen offers `phosphor setup`; a silent Host (no heartbeat
for 90 s) offers `phosphor service restart`; a Host with no published endpoint
reads "enrolled but not reachable" with `phosphor setup` on a Mac and
`sudo tailscale set --operator=$USER && phosphor setup` on Linux, or names
Tailscale stopped or missing when the Host reported so. With an endpoint, an
`unsupported` connection asks for `phosphor update`, `wrong-machine` is an
identity mismatch (remove and add again), a refused grant says access was
refused, and any other unready connection is Connecting… or, once settled, Not
reachable from this computer (check Tailscale here and the tailnet), never a
restart. Only a ready connection advances to Providers, after a short pause.
Further recovery stays in the collapsed Stuck? disclosure.

**Providers** reads the Host's provider readiness and opens the machine page,
whose Providers card has Sign in. The terminal fallback on the Host is
`phosphor providers login PROVIDER`. Provider credentials stay on the Host.
In a terminal, guided `phosphor setup` offers to install Claude Code and the
Claude provider and runs `claude` login when signed out
([host.md](host.md#setup)).

`hosts:claude` reads the Host's `machine.claude` call under the same permission
as `machine.providers`: `{ provider: ok|missing|outdated, cli: ok|missing,
auth: ok|signed-out|unknown }`, validated by the strict shared
`parseMachineClaude`. The Claude Code row then names the missing part and its fix. A
Host older than the call refuses it; main returns null and the row keeps the
single Claude status.

`hosts:claudeUsage <hostId> [laneId] [force]` reads `machine.claudeUsage` the same
way and validates it with `parseMachineClaudeUsage`; null means unavailable or an
older Host. A remote Claude lane's context popover shows it as that lane's plan
usage on the Host ([chat.md](chat.md#what-the-context-meters-popover-shows)).

Terminal capability, controller input, reconnects and privacy are owned by
[terminal.md](terminal.md#host-terminals). Native release resources and wire bounds
are owned by [host.md](host.md#host-terminals).

## Sidebar machine selection

The sidebar machine menu is available whenever remote access is signed in,
even before a Host is enrolled. This Mac is the default when a window opens and survives hiding the sidebar;
selection is not persisted. Add machine opens the existing Machines add flow.
All machines lists local repository groups first, followed by labelled Hosts.

Connected Hosts show repository-grouped lanes, newest first within each folder
(a lane you just created is at the top, as a new local session is), with running, new and needs-you
signals from their existing summaries (`working`, `attention > read`, and
`needs-input` or `failed`). Local activity uses streaming chat state, unseen
session markers/unread counts, pending extension dialogs and chat errors.
The button summarizes only machines other than the selected one.

Reconnecting uses an amber pulsing status dot, and the sidebar says
"Connecting…" for a Host that is connecting, reconnecting or not yet in the
first Host snapshot, never "Not reachable". Down machines show a grey dot,
the directory's last-seen age, and last-known groups with disabled lane and
creation actions. A Host that is enrolled but not yet connected shows the
reachability rule's short phrase (for example "Not reachable yet" or "Never
connected") in blue with an explicit empty state, never a bare "Setting up". A connected
Host with an empty repository shows “No lanes yet” and its capability-gated +. A
ready Host with no folders shows “No folders yet” and, with `workspaces.write`,
an Add folder on MACHINE… button that opens the Host folder browser.
A Host's folders are listed in the Host config's order. Each current folder's
Workspace options menu offers Add folder on MACHINE…, Remove from MACHINE, Move
up and Move down (`RemoteFolderMenuRows`), then Select all lanes, Select merged
lanes and Collapse lanes. The folder header (`RemoteRepositoryGroup`) and the
Host's list (`RemoteHostLanes`, pinned lanes first) are the same components the
web client's Lanes page and Host home render ([web client](web-client.md#one-lane-row-list-and-menu)). A move
sends the whole new order (`hosts:orderRepositories`), so every client sees it
once the Host republishes its repositories; an older Host's refusal is a toast
that says to update it. A move is disabled at either end and without
`workspaces.write`.
Remote actions retain the fixed reconnection/unavailable hints and main's
capability, readiness and stale-connection checks. Creating a remote lane never
falls back to local creation.

The home composer follows the sidebar machine selection (All machines uses This
Mac). A picker override lasts until the next sidebar selection change. This target
is window-local renderer state, never persisted. Host-targeted folder, model and
thinking chips use that machine's repositories and model catalogue.
The branch choice follows the isolation rule above. The model prefers the last usable choice on that Host, then a usable Desktop default,
then the first model of the first signed-in provider, then the first other usable
model. The effective choice is visible.

Host lanes start from the same composer as This Mac (`features/home/StartComposer.tsx`):
the machine, repository and isolation row above a two-row input, **Start lane**,
a hints line and one note line. `useLocalStart` and the Host target in
`RemoteStartView` supply only what differs. On a Host, `@` lists the chosen
repository's files through `hosts:repositoryFiles` (with `workspaces.read`).
The Host has no command list or context-file preference before a lane exists,
so a new Host lane offers no `/` menu or Rules readout; inside a Host lane `/`
lists the lane's own commands. The Swarm switch records its choice on the draft,
as on This Mac. After `hosts:createLane` the client turns Swarm on in the new
lane (`get_commands`, then `/phosphor-swarm on`) before it sends the first
prompt. If the Host's pi lacks pi-subagents or refuses, the lane exists but gets
no first message, and the draft and its choice are kept with a warning.

One rule decides which Host models can be picked, for the new-lane picker and
for a Host lane's model menu alike (`hostModelUnavailability`). Both list what
pi reports available on that machine; the new-lane picker reads it through
`hosts:models`, a lane through its own pi. A model is disabled, with the reason,
when the Host's sign-in check (`hosts:providers`) reports its provider signed
out ("Sign in to Anthropic on bee1"), or when it is a bare Bedrock id that needs
an inference profile. A provider the check does not cover, such as an API key
in the Host's environment, stays usable because pi listed it.

Thinking is remembered per Host in this window, capped at 64 Hosts. Sign-out or
remote disable clears it, and restart resets it; it never writes agent settings.
Without a remembered choice it starts from This Mac's valid default thinking
level, or `off` when unavailable, clamped to the selected model's supported levels.
A successful thinking change in a live Host lane updates that Host's remembered
choice.

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

## Machine settings and provider sign-in

**Settings → Configure → \<Host\>** and **Machines → a Host → Settings** configure that
execution machine, not This Mac. Settings opens on the Host of the active Host lane
(or an open Machines detail, or the Host chosen in the switcher), and Configure still
offers This Mac.
The separate Overview keeps reachability, readiness, reconnect and diagnostics.
The [settings contract](settings.md#host-machine-settings) owns the sections,
review steps, scope, drafts and application timing. Desktop (and the browser, see
[web client](web-client.md#configuration-access-and-lane-deletion)) asks separately
for signed configuration access; old Hosts retain their Readiness sign-in route.
No remote failure mounts a local editor, synchronizes auth or queues a write.

`libs/host-client/src/settings.ts`, shared with the browser, validates the requested
section/folder, projects only reviewed fields, and refuses late results from a
disconnected or replaced connection. Configuration-capability changes invalidate
renderer read generations. Drafts retain non-secret edits per Host/folder; stale
revisions cannot be saved. Unconfirmed writes and account moves are not
automatically retried.

The Host runs supported fixed CLI sign-in paths in an owner-private terminal.
Settings programs require `machine.configure`, `terminal` and `sessions.control`,
rechecked before execution and throughout private terminal access. Input is
sequenced and never replayed after uncertainty. Login content, callback URLs and
credentials never enter the control plane or metadata traffic log. The UI follows
the CLI's browser/code instructions, including any Host-local loopback requirement.

Configuration auth exits reach Desktop only after authoritative verification and
account registration, not merely the CLI's printed success. Status is re-read on
completion. Configuration programs have a fifteen-minute bound and are stopped
when their admitted connection or configuration authority is lost; regranting
access does not revive them. Desktop drops their private handles and pending input
on authority loss. Cleanup kill remains allowed.

Legacy Readiness sign-in still needs `terminal` plus `sessions.control`, with one
PTY per provider and two per Host. Its existing ten-disconnected-minute grace is
preserved. See [provider login](host.md#providers-login).

## Remote lane surface isolation

The lane artifact pane reads only its explicit session id. An empty Host reply
clears that lane's cached artifacts; switching back restores the Mac lane's own
artifacts, not a global selection. Workspace writes from a remote artifact are
disabled; [remote surface gaps](future-features.md#remote-surface-gaps) owns this limitation. Save and PDF export explicitly
target This Mac. The top-bar artifact count belongs to the active lane.

Remote slash commands come from the lane, and file mentions search its Host file
list. Thinking levels derive from the lane model. Local rules/MCP menus are hidden; the
Swarm switch works as on This Mac, against the lane's own status. For the lane's
controller, `!cmd` runs in the Host's shell and a queued message's ✕ drains and
re-queues on the Host. A `!cmd` still running at the Host's command deadline
shows as unconfirmed rather than failed, keeps its Stop, and its output arrives
with the lane's next snapshot; other viewers see the command only then. Rewind
and fork are refused
with the fixed unavailable hint. The top bar's Session options work on a Host
lane for its controller (compaction, auto-retry, queue modes). Other viewers see
a mode change on their next lane snapshot. pi reports no auto-retry state, so
that toggle shows what this window last set, not the Host's value; Export HTML stays
a This Mac action ([chat](chat.md)). Continue waits for the remote receipt and echo;
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

Host-generated names change the lane title, not its branch. The branch a lane
row and the top bar show follows the lane's folder after every run
([Host lifecycle](host.md#remote-lane-names-and-lifecycle)).
[Host naming](host.md#remote-lane-names-and-lifecycle) owns package resolution and diagnostics.

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
