# Future features

This file holds decided or explored directions that are not built. It is an
exception to the present-tense rule, not a shipped contract or a delivery promise.
An item moves into the living doc of its surface in the same diff that builds it
and is deleted here. [Remote access](remote-access.md) owns what exists now.

Component numbers refer to the remote-access implementation plan. Components
45 (machine engine), 48 (sharing) and 49 (attention) extend that plan. Dependencies
below name work, not claims that it is complete. The decisions labelled
**Decided** are the user's decisions of 2026-10-12.

## Live connections to every machine

**Problem.** Selecting one machine must not hide work finishing on another.
A machine selector alone cannot keep a fleet's lane state honest.

**Decided.** Desktop will stay connected to every machine that is up, not only
the selected one. Each will supply a light summary feed of lane status, unread
counts and attention. Open lanes will receive full streams. Each surface will
have two kinds of WebSocket stream: Supabase Realtime for machine-directory
changes, and each Host's own WSS over Tailscale for lanes and machine state.
The control plane will not carry lane data.

**Design and dependencies.** Components 07, 08 and 21 will provide Host-owned
projections and subscriptions: a snapshot at sequence N, replay after N, and an
explicit reset when a gap is older than the bounded replay buffer. Buffers,
per-viewer queues and summary subscriptions must be bounded; a slow viewer must
not stall pi. Component 10 will permit many viewers and one renewable controller,
with explicit takeover, not a second session writer. Routine ownership will
remain stronger than an interactive lease. Grants (18) will bound
remote authority; routing and store isolation (28-30) will keep machines separate.

**Touches.** Today `apps/desktop/electron/control/client.ts` handles HTTP directory
requests; `electron/control/live.ts` supplies directory change signals and
fallback polling. Neither is a Host connection manager. `stores/machines.ts`
projects only the enrolled directory, and `stores/sessions.ts` and `stores/chat.ts` use local session
keys. The shared `hostResourceKey` helper will support isolation, but the stores
and `libs/session-runtime/src/pi/session-events.ts` still need Host projections,
network delivery and attach/detach separate from stop/dispose.

**Open questions.** Set caps for connected machines, open full streams and replay
bytes. Decide how stale summaries are labelled during grant renewal or sleep,
and which summary fields need lazy detail requests.

**Risks.** Fan-out can multiply memory and traffic. Reset must replace stale state
without replaying prompts. Revocation and lease expiry must end authority without
killing work already running on the Host.

## Cross-machine attention and notifications

**Problem.** Work can finish, fail or ask for input on a machine the person is
not viewing. Reading a lane on one surface should clear its badge everywhere.

**Decided (component 49, new).** Every machine, including the Mac, will emit:

```text
{id, machineId, machineName, laneId, lane, project,
 kind: finished | needs-input | failed | routine-finished | routine-paused,
 at, seq}
```

The notification title will name the machine, such as "bee1 · phosphor".
Clicking will switch to that machine and lane. Event ids will deduplicate.
The Host will keep read state and broadcast "read up to seq N", so reading on
one surface clears all. The non-push portion is M2; Web Push is M4 with the PWA.

**Design and dependencies.** Components 07, 08 and 21 will carry attention and
read watermarks on the machine feed; 29-30 will route navigation by machine and
lane. Components 39-41 will add the browser/PWA consumer. A closed PWA will use
Web Push sent by each Host, with a minimal payload end-to-end encrypted to the
device. The device will register its subscription with that Host over Tailscale.
The control plane will store nothing new. iOS requires installation on the Home
Screen and iOS 16.4 or newer; push is not a promise of background WebSockets.

**Touches.** Today `apps/desktop/electron/routines/index.ts` raises OS notifications
only for routine outcomes. `stores/sessions.ts` keeps background-lane unread
counts in the renderer; `stores/machines.ts` only projects directory status. Machine-owned events and durable read watermarks will replace neither with
a cloud lane store. Desktop's notification adapter will need click navigation.

**Open questions.** Define durable event retention and expiry of unreachable
push subscriptions, and whether OS notifications go to
every surface or only a chosen one. Define device encryption-key registration
and rotation, distinct from a Host's identity key.

**Risks.** Push providers still see delivery metadata. Names can reveal projects
on lock screens; payloads should disclose as little as possible. Duplicate,
out-of-order or expired events must not resurrect a read badge. Hosts need
bounded retry queues and explicit subscription revocation.

## Share this computer

**Problem.** A person should be able to continue a Mac's lanes from another
surface without installing a second runtime that competes with Desktop.

**Decided (component 48).** Sharing will be an option on every Phosphor install
with a UI. A headless Host will always be shared. Sharing will not turn local
use into a sign-in requirement.

**Design and dependencies.** `libs/session-runtime` already shares session
admission, ownership and deletion. It does not yet supply the whole machine.
Component 45 must extract the machine engine: package jobs and provider logins
(`electron/pi/` and `electron/claude/`), artifact library/protocol adapters,
`electron/routines/`, skills, `electron/pty/`, and `electron/fs/`. These paths
are under `apps/desktop/`. Electron dialogs, notification delivery, preview
schemes and secure storage will remain platform adapters, not Host dependencies.

Component 21's authenticated HTTP/WSS API must be a library mounted by both
`apps/host` and Desktop main over that engine. Desktop will enroll the Mac with
its own identity and expose the same listener on its Tailscale address, using
private HTTPS/WSS transport, not a public relay. Enrollment/grants (17-18) and
controller leases (10) are prerequisites, not permission to tunnel raw IPC.
The Mac's identity private key will live in the OS keychain, not the control
plane or Desktop's account refresh-token vault.

**Lifetime and revocation.** Sharing will serve only while Desktop runs and the
Mac is awake. Component 25's macOS user service is the always-on path, not a way
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

## Per-machine primitives: explicit copy now, sync later

**Problem.** The model, skill or connector configured on the laptop may not
exist on the machine actually running pi. A shared-looking settings page can
silently configure the wrong machine.

**Decided.** Skills, artifacts, routines, extensions, provider logins and MCP
config will belong to the execution machine. Selecting a machine will show its
own primitives (33, 34, 38). Moving a copy will be explicit: "Copy to bee1",
with confirmation showing what will be written where and any conflicts.
Primitive sync is a later feature, not automatic fleet sync or orchestration.
Provider credentials will never move.

**Design, dependencies and touches.** Machine-qualified views (28-30), file
transfer (31-32) and the engine (45) will back these per-primitive operations:

- Skills are files. `electron/pi/skills.ts` already resolves through pi and
  limits mutations to writable roots, with import previews and bundle bounds.
  Copy will need a target scope, content comparison and explicit conflict choice.
- Artifacts have indexes and version blobs (`electron/artifacts/artifact-library.ts`
  and `libs/pi-extensions/pi-ext/artifact-store.ts`). Copy must preserve referenced
  versions and integrity, not send temporary preview URLs or overwrite identity.
- Routines are SQLite rows, schedules and run history (`libs/session-runtime/src/routines/repository.ts`).
  The Host already owns a daemon scheduler; cross-machine copying and Desktop
  remote routine routing remain future work.
  Copy should separate a definition from execution history, remap workspace/model
  choices and keep imported schedules inactive until explicitly enabled.
- Extensions are pi packages with specs and versions. `electron/pi/packages.ts`
  runs pi's install/remove/update CLI. Copy should propose a verified package
  version, not transfer a machine's node_modules or silently update dependencies.
- MCP config (`electron/pi/mcp-config.ts`) spans user and project scopes and can
  contain secrets. Copy or sync must review individual entries and strip secrets
  by default. OAuth remains adapter-owned; credentials will not sync blindly.
- Provider logins stay on the target. `apps/host/src/commands/provider-login.ts`
  already owns host-side login; guided remote flows depend on component 44.

**Open questions.** Later sync needs per-primitive identities, revisions and
three-way comparison, deletion semantics and conflict UI. File merge may suit
skills, but not schedule activation or package upgrades. Decide whether artifact
copies fork history and how machine-specific paths are remapped.

**Risks.** Last-writer-wins can erase local edits, run a routine twice or leak MCP
secrets. Copy is not fleet management: each session and each routine scheduler
remains machine-local, consistent with CLAUDE.md fact 5.

## Lane migration (direction decided, design exploratory)

**Problem.** A lane started on the Mac should be able to continue on bee1 when
the Mac needs to sleep, without maintaining two active copies of the work.

**Decided.** Lane migration will be built: a lane started on one machine can move to another and continue there. The design below is an exploration, not settled.

**Proposed design and dependencies.** Build on retained Host state (06), receipts
(09), control/ownership (10), lane creation (11), file transfer (31-32), artifact
history (34) and the machine engine (45). This is a new component to scope, not
an existing execution capability. Migration must happen between turns: pi only
persists a session at turn end. Abort is not proof that all in-flight work was
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

## Install from Desktop

**Problem.** Today a person installs the Host by hand and uses `phosphor login`;
Desktop cannot prepare a remote machine or verify that it can run lanes.

**Proposed design and dependencies.** Verified Host bundles (23), an approved SSH
bootstrap plan (26), and guided onboarding (36) will make installation explicit.
Opt-in Tailscale discovery (22) will suggest candidates, never auto-trust them or
scan ports. Service installers (24-25), lifecycle/retained-data rules (27), and
the authenticated Host API (21) are prerequisites to a usable connection.

**Touches.** `features/machines/AddMachineDialog.tsx` guides manual setup and approves a code,
not an installation. Host config, `doctor`, identity and acceptance commands will
supply preflight and post-install evidence. Desktop main will own SSH and verified
transfer; provider credentials will stay on the Host. User approval must name
what is installed, where, and which service/Serve configuration changes.

**Open questions.** Define supported SSH prerequisites, bundle update policy and
manual fallbacks when provider login or Tailscale HTTPS is unavailable. Broader
guided provider login is component 44, not implicit credential forwarding.

**Risks.** Changed SSH keys, cancelled approval, wrong architecture, partial
transfer and existing Serve routes must fail safely. Discovery is not identity
proof. Removing a directory entry is neither uninstall nor evidence of success.

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
