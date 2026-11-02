# Future features

This file holds decided or explored directions that are not built. It is an
exception to the present-tense rule, not a shipped contract or a delivery promise.
An item moves into the living doc of its surface in the same diff that builds it
and is deleted here. [Remote access](remote-access.md) owns what exists now.

## Remote surface gaps

These operations are not implemented remotely. Their controls are hidden or
refuse with the fixed unavailable hint; they never run against This Mac instead.

| Surface         | Missing capability                                                                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat and lanes  | Fork, clone, rewind/tree editing, shell shortcuts, queued-message removal, local rules/MCP controls, the Subagents pane, lane HTML export          |
| Files           | Content search, rich previews/quick look, external imports and open-in-app                                                                         |
| Skills          | Catalogue install, upload, export to a file, discovery and in-place edits                                                                          |
| Settings        | Raw configuration editors, project/non-npm package mutation, per-folder Host directives, and cross-machine settings or authentication copying/sync |
| Artifacts       | Revision-aware writes from an artifact into a remote workspace                                                                                     |
| Routine history | Open/Continue output lanes and full execution diagnostics in Desktop                                                                               |
| Clients         | Browser/PWA lane client, mobile delivery and Web Push                                                                                              |
| Portability     | Cross-machine lane migration, primitive copy/sync and sharing Desktop's local runtime                                                              |

## PWA attention and Web Push

In-app attention, machine-titled Desktop notifications and Host read watermarks
are built. A browser/PWA consumer needs Web Push from each Host when closed, with
a minimal payload encrypted end to end to the device.
The device registers with that Host over Tailscale. Control stores nothing new.
iOS requires Home Screen installation and iOS 16.4 or newer.

**Open questions.** Define event retention, subscription expiry, device-key
registration and rotation, and which devices receive notifications.

**Risks.** Push providers see delivery metadata. Names can reveal projects on lock
screens. Duplicate or expired events must not resurrect read badges. Hosts need
bounded retry queues and explicit subscription revocation.

## Share this computer

**Problem.** A person should be able to continue a Mac's lanes from another
surface without installing a second runtime that competes with Desktop.

**Decided.** Sharing will be an option on every Phosphor install
with a UI. A headless Host will always be shared. Sharing will not turn local
use into a sign-in requirement.

**Design and dependencies.** `libs/session-runtime` already shares session
admission, ownership and deletion. It does not yet supply the whole machine.
Sharing needs a common machine engine: package jobs and provider logins
(`electron/pi/` and `electron/claude/`), artifact library/protocol adapters,
`electron/routines/`, skills, `electron/pty/`, and `electron/fs/`. These paths
are under `apps/desktop/`. Electron dialogs, notification delivery, preview
schemes and secure storage will remain platform adapters, not Host dependencies.

The authenticated HTTP/WSS API needs to be a library mounted by both
`apps/host` and Desktop main over that engine. Desktop will enroll the Mac with
its own identity and expose the same listener on its Tailscale address, using
private HTTPS/WSS transport, not a public relay. Enrollment, grants and
controller fences are prerequisites, not permission to tunnel raw IPC.
The Mac's identity private key will live in the OS keychain, not the control
plane or Desktop's account refresh-token vault.

**Lifetime and revocation.** Sharing will serve only while Desktop runs and the
Mac is awake. The Host's macOS user service is the always-on path, not a way
to work while asleep. Turning sharing off must stop accepting remote access and
close streams; reenrollment and identity revocation need explicit UI semantics.
It must not delete lanes or interrupt local work just to remove remote access.

**Open questions.** Choose toggle placement and whether off retains enrollment.
Define engine adoption between Desktop and a separate `phosphor run`, startup
failure UI, and keychain access for the user-service path. The shared service's
path locks are process-local: a machine-wide ownership protocol is still needed
so Desktop and `phosphor run` cannot both write the same session file.

**Risks.** Mounting a listener before extraction creates two implementations.
Electron's node-pty ABI cannot be copied into a Node Host. Sleep, Desktop quit,
locked keychains and two runtimes can each break sharing unless diagnosed.

## Cross-machine primitive copy and sync

**Problem.** The model, skill or connector configured on the laptop may not
exist on the machine actually running pi. A shared-looking settings page can
silently configure the wrong machine.

**Decided.** Skills, artifacts, routines, extensions, provider logins and MCP
config belong to the execution machine. Machine-qualified skills, artifacts,
routines and provider sign-in already exist, and skills already copy between
machines ([Skill sharing](remote-desktop.md#skill-sharing)). Moving any other
primitive will be just as explicit: "Copy to bee1", with confirmation showing
what will be written where and any conflicts.
Primitive sync is a later feature, not automatic fleet sync or orchestration.
Provider credentials will never move.

**Design, dependencies and touches.** Machine-qualified views, bounded file
transfer and a common machine engine must back these operations:

- Skills copy whole into the target's global folder today. Still open: project
  scope as a target and a content comparison before Replace.
- Artifacts have indexes and version blobs (`electron/artifacts/artifact-library.ts`
  and `libs/pi-extensions/pi-ext/artifact-store.ts`). Copy must preserve referenced
  versions and integrity, not send temporary preview URLs or overwrite identity.
- Routines are SQLite rows, schedules and run history (`libs/session-runtime/src/routines/repository.ts`).
  The Host owns a daemon scheduler and Desktop routes its routine operations.
  Cross-machine definition copying remains future work.
  Copy should separate a definition from execution history, remap workspace/model
  choices and keep imported schedules inactive until explicitly enabled.
- Extensions are pi packages with specs and versions. `electron/pi/packages.ts`
  runs pi's install/remove/update CLI. Copy should propose a verified package
  version, not transfer a machine's node_modules or silently update dependencies.
- MCP config (`electron/pi/mcp-config.ts`) spans user and project scopes and can
  contain secrets. Copy or sync must review individual entries and strip secrets
  by default. OAuth remains pi's (`pi mcp login`); credentials will not sync blindly.
- Provider logins stay on the target. `apps/host/src/commands/provider-login.ts`
  owns Host-side login, including the private terminal in Machines Readiness.
  Credentials never participate in copy or sync.

**Open questions.** Later sync needs per-primitive identities, revisions and
three-way comparison, deletion semantics and conflict UI. File merge may suit
skills, but not schedule activation or package upgrades. Decide whether artifact
copies fork history and how machine-specific paths are remapped.

**Risks.** Last-writer-wins can erase local edits, run a routine twice or leak MCP
secrets. Copy is not fleet management: each session and each routine scheduler
remains machine-local, consistent with AGENTS.md fact 5.

## Lane migration (direction decided, design exploratory)

**Problem.** A lane started on the Mac should be able to continue on bee1 when
the Mac needs to sleep, without maintaining two active copies of the work.

**Decided.** Lane migration will be built: a lane started on one machine can move to another and continue there. The design below is an exploration, not settled.

**Proposed design and dependencies.** Build on retained Host state, receipts,
controller fences, lane creation, bounded file transfer, artifact history and a
common machine engine. This is not an existing execution capability. Migration must happen between turns, after the current turn has settled. Abort is not proof that all in-flight work was
saved, so the UI should prefer finishing the turn before freezing it.

Transfer pi's session JSONL and arrange its target cwd-mangled directory using
`libs/session-runtime/src/pi/pi-paths.ts`. Preserve the conversation's entry
relationships, not a renderer projection. Transfer committed work through the
branch, and uncommitted work as a verified patch or git bundle with an explicit
plan for untracked files. Include artifact versions, durable attachments the
transcript references, and lane metadata such as name, branch and markers.
`electron/pi/session-cwd.ts`, `session-writer.ts`, `electron/fs/git-worktrees.ts` and
`stores/sessions.ts` are relevant seams, not a ready migration API.

Do not transfer provider credentials, live tool processes or terminals. Absolute
paths inside transcript/tool text cannot simply become valid on the target;
header repair is not a safe global text replacement. External tool effects are
not transactional and cannot be replayed as part of migration.

**Handoff.** Finish or explicitly stop the turn; freeze the source read-only;
transfer and verify content, repository state and target prerequisites; resume
under the target's sole writer; retire the source with a pointer to the target.
Durable receipts must distinguish transfer failure from an unknown resume
outcome. A failed handoff must not unlock both writers. Ownership fencing and
rollback before versus after target admission need a protocol of their own.

**Caches and preflight.** Provider prompt caches are provider-held, keyed by
account and exact prefix, with short lifetimes. A different account or system
prompt starts cold and may behave differently. Compare versions, skills,
extensions, context files, MCP readiness and provider/model availability before
moving, and say what differs. Phosphor cannot transfer or guarantee a cache hit.

**Open questions.** Decide lane identity across machines, source-pointer lifetime,
how to move a non-Git workspace, and which path differences block migration.
Define routine-owned lane eligibility, attachment discovery and target admission
without rerunning the last prompt. Provider-specific cache behavior needs
canaries rather than a universal lifetime promise.

**Risks.** Split writers, lost unsaved work, unresolved attachments and path
rewrites can corrupt continuity. Primitive differences can change behavior even
when every transferred byte verifies. A sleeping source cannot complete a
handoff, so transfer must finish before sleep.

## Windows builds

Paused on 2026-10-15 to cut CI time: the CI Windows packaging and packaged-app
smoke job and the Windows leg of `release-continuous.yml` are removed, and the
release no longer requires `Phosphor-<version>-x64.exe` or `latest.yml`. The
Windows code paths (NSIS config, `win-launch.ts`, signing block) stay in the
tree. To resume, restore the CI job and the release matrix entry from git
history, put the exe, `latest.yml` and checksum pattern back in `finalize`, and
re-add the README install note. Windows installs stay on the last Windows
release until then.

## Voice input beyond English dictation

**Problem.** [Voice input](voice.md) dictates English only, starts from a mouse
click, and shows nothing until the user stops.

**Proposed design and dependencies.** Offer NVIDIA Parakeet TDT 0.6B v3 (25
European languages, CC-BY-4.0, about 465 MB) as a third model; it runs on the
same `sherpa-onnx` runtime as a transducer config in `electron/voice/engine.ts`.
Add a push-to-talk keybinding beside the click, and stream each segment's text
into the composer as it is transcribed instead of only at the stop.

**Touches.** `electron/voice/manifest.ts` and `engine.ts` for the model,
`features/voice/useDictation.ts` and the Keybindings tab for the shortcut, and a
`voice:segment` push for live text.

**Open questions.** Whether Parakeet's speed on the WebAssembly build (single
thread) is acceptable, or needs the native `sherpa-onnx-node` addon and its
per-architecture packaging. Which key, given that Escape already aborts a turn.

**Risks.** A 465 MB download needs a clearer size warning. Live text competes
with the user's own typing for the caret.

## MCP: project trust and leftover adapter tokens

**Problem.** pi ignores a project's `.pi/mcp.json` until the folder is trusted,
and Settings → Connectors can only say so and send the person to a terminal to
run `pi` and choose Trust ([mcp.md](mcp.md#config-two-files)). Separately, the
move from pi-mcp-adapter leaves the adapter's OAuth tokens in the OS credential
store, where nothing reads them again.

**Proposed design.** Let Connectors trust the folder itself by writing pi's
`trust.json` entry for the canonical path, with the same wording pi's own
question uses, and show the decision it replaces. After the migration, offer
to delete the adapter's credential-store entries for the servers that moved.

**Touches.** `apps/desktop/electron/pi/mcp-config.ts` (`projectTrust` reads the
same store), `features/settings/tabs/ConnectorsTab.tsx`,
`features/connectors/MigrationCard.tsx`, and a main-side credential-store
helper.

**Open questions.** Whether writing trust from a GUI needs pi's own command for
it rather than a file edit, and how the adapter named its keychain entries
across versions.

**Risks.** Trust lets a repository's config start local commands, so it must
stay an explicit, per-folder choice. Deleting the wrong keychain entry signs a
person out of something else.
