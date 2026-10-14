# Future features

This file holds decided or explored directions that are not built. It is an
exception to the present-tense rule, not a shipped contract or a delivery promise.
An item moves into the living doc of its surface in the same diff that builds it
and is deleted here. [Remote access](remote-access.md) owns what exists now.

Component numbers refer to the remote-access implementation plan. Components
45 (machine engine), 48 (sharing) and 49 (attention) extend that plan. Dependencies
below name work, not claims that it is complete. The decisions labelled
**Decided** are the user's decisions of 2026-10-12.

## PWA attention and Web Push

In-app attention, machine-titled Desktop notifications and Host read watermarks
are built. Components 39-41 add the browser/PWA consumer. A closed PWA uses Web
Push from each Host, with a minimal payload encrypted end to end to the device.
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

## Guided Host onboarding and discovery

Desktop installs signed Host bundles over SSH, performs setup and enrollment,
and installs the user service. [remote-access.md](remote-access.md#install-a-host-over-ssh)
owns that built flow.

Component 36 adds guided onboarding and opt-in Tailscale discovery to suggest
candidates. Discovery never auto-trusts machines or scans ports. Provider
credentials stay on the Host. Guidance needs explicit prerequisite checks and
manual fallbacks when provider login or Tailscale HTTPS is unavailable.

**Risks.** Discovery is not identity proof. Removing a directory entry is neither
uninstall nor evidence of success.

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
