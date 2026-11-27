# Future features

This file holds decided or explored directions that are not built. It is an
exception to the present-tense rule, not a shipped contract or a delivery promise.
An item moves into the living doc of its surface in the same diff that builds it
and is deleted here. [Remote access](remote-access.md) owns what exists now.

## Remote surface gaps

These operations are not implemented remotely. Their controls are hidden or
refuse with the fixed unavailable hint; they never run against This Mac instead.

| Surface         | Missing capability                                                                                                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat and lanes  | Writable Host composer rules/MCP popover; worktree Merge into main                                                                                                                                    |
| Files           | Content search, Quick Look, external imports, per-file Revert in Changes, Host file-list truncation flags; in a browser, files over 100 MB to download or 50 MB to preview, and drag moves on a phone |
| Skills          | Upload and discovery UI; editing beyond user skill source                                                                                                                                             |
| Settings        | Unrestricted raw file editors, project/non-npm package mutation and cross-machine settings sync                                                                                                       |
| Routine history | Full execution diagnostics                                                                                                                                                                            |
| Portability     | Larger lane transfers, submodule/LFS support, primitive copy/sync                                                                                                                                     |

## Service follow-ups

[This Mac’s service](local-service.md) owns the implemented runtime and its release gate. These extensions are not part of migration:

- **Paged lane projection.** Merge inventory pages into the sidebar and lift the legacy 64-folder / 1,000-lane ceiling. Paging a catalog query is not paging the subscribed lane topic.
- **Routine `allowOps`.** A reviewed, per-routine authorization for unattended ops that otherwise ask. Today those requests are refused, not pre-approved by routine trust.
- **Brain reader processes.** The Host-owned Brain proposal below would run guarded reader calls on the owning Host instead of adding a general-purpose `owner.print` command.

## One Brain per Host

**Open requirement:** sending a message from the page or CLI needs a production Agent
launch that enforces permissions on every tool call. A synthetic process exercises the
protocol, but does not qualify a real launch. Until then, Host conversation history is
readable with permission and interactive messaging is off.

Proposal, not a shipped contract. **A Host owns at most one Brain; Desktop, PWA and CLI select it.** A fresh Host starts with Brain off. Enabling it creates that Host's store and agent. Disabling it stops reads, recall and automatic checks but keeps its data. Disconnecting a client does neither. No shared account Brain, cross-Host recall, automatic copy on lane transfer, or Control-plane storage of memories. A source lane moving away should leave its origin visible, not silently point at a different lane.

### What needs to move

| Today                                                                                                                                                                                        | Proposed change                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libs/memory-engine` owns SQLite, graph, recall indexes and journal; `libs/brain-runtime/src/service.ts` composes the reader, queue and agent.                                               | Reuse both. One writer per Host state directory, a read-only search worker, no new graph schema just for changing owners. No copying events into a second knowledge store.                                                                                                                |
| `apps/desktop/electron/brain/runtime.ts` supplies the directory, pi launch/account, lane activity, embeddings, search and Brain Agent. Search and embeddings use Electron utility processes. | Compose the same ports in `apps/host/src`. Use isolated Node workers with bounded resources, cancellation and a small environment allowlist; reuse the worker protocols. Resolve the reader's provider, cwd and session file on the Host. Do not expose a general shell or model-run RPC. |
| `apps/host/src/session/app-services.ts` registers Desktop's recall endpoint. `apps/host/src/ops/handlers/brain.ts` exposes search/flag only to the asking lane.                              | Bind the lane port directly to the Host's Brain; keep the saved pi session identity and per-live-lane briefing numbers. No Desktop heartbeat, socket registration or forwarded curator token needed.                                                                                      |
| `libs/shared/src/ipc/brain.ts` is a Desktop contract. Queue takes a session path, Tell returns a path, extraction can include source text, and status is richer than a lane should receive.  | Inventory every method against a typed Host operation and caller. Do not publish the IPC map as a remote API. Use opaque Host lane, job, run, entity and change refs; resolve files on the owner. Define separate summary, evidence and settings responses.                               |
| `localBrain` gates the shared UI; the PWA refuses Brain IPC.                                                                                                                                 | Show the selected Host's Brain via `libs/host-client` and a shared UI adapter. The PWA stays a client: no SQLite, model downloads, service tokens or offline copy in the browser.                                                                                                         |

### Host storage and lifecycle

Put `brain/` under the Host's **persistent per-user state**, not its versioned install, a repo or an enrolled Host ID. Keep `brain.sqlite` and its journal, private agent rules, stable transcript binding and retained read records. Keep verified model files in a replaceable model directory. Enrollment or a binary update must not create a second Brain. Treat existing source and agent transcripts as private Host files; never take an arbitrary path from a surface. Keep the current retention and erasure contracts, including what Forget does not erase.

Use the Host's run lock plus a Brain ownership check at all write entry points, including recovery and updates. Lazy-start workers; no model load or download just to list machines or open Settings. On shutdown stop admitting writes, settle or interrupt work at a recorded boundary, release workers, then release ownership. On restart resume eligible reads from their durable checkpoints; do not resend a Tell or an uncertain agent turn. Preserve the current automatic-check trigger, daily cap and on/off semantics. Report unavailable provider, missing model and low disk as different states. A broken Brain must not prevent ordinary Host lanes from starting.

**Release blocker:** `embedding/model-manifest.ts` currently allows only `darwin-arm64`, and the reader queue waits for embeddings to be ready. Bundling the pi extensions does not bundle an inference runtime. Test the signed macOS arm64/x64 and Linux arm64/x64 Host bundles with their pinned Node, native dependencies, license notices and verified model files. Measure install size, cold start, steady and peak RSS, concurrent lane latency and recall on a bounded corpus. Advertise the reader only on targets that pass. Don't claim keyword search alone makes a Host able to save reads.

### The Brain lane is a real session with a different home

Use one Host-reserved **Brain Agent** lane per Brain. Store its stable binding; a per-spawn process handle, folder name or emoji is not proof of identity. Reuse the Host's session service, stream, controller lease, dialog handling and response-ID matching. Only the Host may create/resume that binding with curator tools. A copied, imported, forked or ordinary lane in the same folder must not acquire them. Keep the agent out of its own reader and keep reader calls tool-free.

On **Brain → Brain Agent**, render the actual conversation, composer, streaming response, pending questions and Stop. Tell opens or continues this same conversation. Ask still searches memories and never sends a prompt. Show run progress and Undo in What changed as today. The lane must not appear as a workspace, in recents, quick-open, normal lane lists, move/archive/delete menus or generic lane subscriptions. Enforce that on the Host, not just in the sidebar. The page and CLI attach to the same transcript; one controller answers a dialog, other clients may watch when authorized. With no controller, show a pending question or time out under an explicit unattended policy; never supply an answer on the owner's behalf. Stopping Defrag must not stop a turn the owner started.

### API, CLI and settings

Add an optional `ready.brain` feature marker. Absence means unsupported, not disabled. Use existing negotiated request/response envelopes; do not add unknown v1 frame types or names to legacy capability arrays. The marker is not permission. Follow the signed, optional-claim pattern in `docs/remote-protocol.md` for explicit Brain access; define read, conversation/control, evidence and configuration rights before exposing data. Recheck on renewal, result delivery and reconnect. A machine grant is not an interactive owner's grant.

| Caller               | Allowed path                                                                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ordinary agent lane  | Its own Host's escaped recall briefing and flag with identity set by the owner. Preserve existing governed catalog behavior only where explicitly allowed. No curator operations, evidence dump, settings change or cross-Host search via `--host`.    |
| Reserved Brain Agent | Local, narrowly scoped curator operations. No client-supplied role or generic lane command can grant this.                                                                                                                                             |
| Desktop and PWA      | Use the same Host feature handlers and grant checks. Viewing a graph, opening source evidence, controlling a lane and changing settings are distinct actions. Honor controller ownership for messages and dialogs.                                     |
| CLI                  | Use the existing op catalog, Unix socket or targeted Host route and its own principal. Support a single explicit target for Brain management. Keep confirmations for destructive or sensitive operations; a terminal is not an attested Desktop owner. |

The [Brain CLI](host-brain-api.md#cli-approval) covers this Host only. Not built: a named remote target (`phosphor brain status --host Harbor`) and `brain enable`/`brain settings get/set` shorthands. Keep existing op names and meanings where compatible; owner Ask is not `brain.search` pretending to be a lane. Allow an authorized controller to list and answer pending dialogs by ref. No `--host all` for Brain contents or writes. A headless Host must have a usable authorized local CLI path; if today's install lacks that socket, make admission a prerequisite, not a TCP fallback. Before exposing a write, define its result or job receipt, revision check, confirmation policy and behavior after a lost reply. Never resend a non-idempotent action on reconnect. Redact Brain content from op audit, errors and diagnostics; return user-facing projections, not raw status objects.

**Settings → Brain** applies to the selected Host: enabled, recall in lanes, automatic checks, reader selection, download/remove embedding model, never-read rules and exclusions. Preserve existing values on migration. List only that Host's available providers; keep provider secrets on it. Clearly label which Host will run the reader and where its configured provider can receive transcript text. Gate fresh setup separately from the current device preview preference. Keep UI-only choices on the device. Disabling, removing the model and resetting knowledge must be three distinct actions.

Key navigation, stores, queries, pagination, revisions and command receipts by Host identity and Brain generation. On Host switch or grant loss cancel subscriptions, clear private views, drafts or references that belong to the old Host, and discard late responses. Show unsupported, disabled, loading model, unavailable and unauthorized distinctly. Never fall back to This Mac. Use bounded graph/evidence pages and the existing paged lane transcript path; no full-store or full-transcript broadcast. Do not persist Brain content in PWA caches, URLs or notification text.

### Moving the existing Desktop Brain without starting over

1. **Detect, don't guess.** On This Mac only, negotiate support over the local owner socket and inventory source schema, generation, pending reads, agent runs, rules, transcripts, source-lane mappings, model and target state. Support Macs whose normal lanes already migrated as well as first-time service setup. Never offer to seed a remote Host from the laptop. A nonempty target is a conflict; do not merge or overwrite either Brain.
2. **Quiesce and snapshot.** Freeze new reads, turns and writes on both owners; wait for active work or offer an explicit cancel. Stage an owner-created, WAL-consistent SQLite backup and a manifest of retained files in a private staging directory. Do not copy a running database as loose files, or copy credentials, transient sockets or stale process handles. Preserve the original until verification and a separate cleanup decision.
3. **Verify before switching.** Import using existing supported schema upgrades. Compare stable IDs and content digests for memories, entities, mentions, current and ended relations, evidence, jobs, flags, journal and preferences. Check integrity and foreign keys. Keep missing/archived source origins as history. Map source paths through the Host lane inventory, reconnect custom rules and the existing Brain Agent conversation, and verify model hashes or request a re-download. On a disposable validation copy, exercise recall, a graph walk and undo of a pre-move change.
4. **Commit ownership once.** Record a durable migration ID, source generation, target manifest and commit state. Atomically publish the verified store under the Host lock, then have Desktop route exclusively to it. Crash-test each boundary, including a lost commit acknowledgment: resume by ID and ask which owner committed. Never infer ownership from an empty directory or a lost connection. Only one side may admit writes at any point.
5. **Recovery is explicit.** Before commit, abort and return the untouched source to service. After commit, repair or restore from the Host, never silently serve the pre-move copy. A downgrade or break-glass restore must refuse Brain writes if it cannot preserve post-move history. For an older Host, Windows in-app or dev with no Host, leave existing stores intact; do not turn a temporary compatibility adapter into a second permanent owner.

### Build order and acceptance gates

| Step                          | Deliverable and proof needed to proceed                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Freeze the boundary        | Map all Desktop IPC, agent tools, resources and settings to caller, Host op, response and compatibility behavior. Characterize current v8 save/undo, graph and agent-turn behavior with synthetic fixtures. Specify ownership and legacy-client version gates.                                                                                                                                                                                                                   |
| 2. Native vertical slice      | Start an isolated Host with no Electron or Desktop registration. Enable Brain, read a synthetic Host lane, query a relationship, restart the Host and undo the saved read through the CLI. Prove real model loading and one guarded reader call on the first supported release target, not just a stub.                                                                                                                                                                          |
| 3. Brain Agent lane           | Reserve the lane, implement curator admission and convey user/runtime turns. Demonstrate CLI send/watch/stop and controller handoff. Preserve a pending dialog across a surface reconnect; no ordinary lane may list, read, move or impersonate this session.                                                                                                                                                                                                                    |
| 4. Two surfaces, two Hosts    | Ship shared Host client and Desktop/PWA Brain page, embedded lane and targeted settings. Use Hosts with colliding local IDs and different enabled/recall values. Switch during search, read and Tell; assert no wrong-host data, settings write or duplicate message. Test compact PWA and loss of grants.                                                                                                                                                                       |
| 5. Safe handover              | Test v7 and v8, a nonempty target, missing sources/model, encrypted/private owner storage as available, full disk, interrupted work, retry and crash before/after commit. All original memories, relationships, rules, conversation and undo history survive on the winning owner.                                                                                                                                                                                               |
| 6. Ship and retire the bridge | Publish supported Host bundles and additive authorization support before requiring them in clients. Only start handover when both sides advertise readiness. Test old/new combinations and stepwise upgrades. Remove Desktop writer registration, curator exception, path DTOs and blanket browser exclusions from the native path; remove legacy code only after its recovery window. Update living docs and remove the daemon-mode Brain lane known issue when its e2e passes. |

**Decisions before implementation:** which native targets must support the complete reader at first release; whether Windows/in-app remains transitional or becomes client-only; which remote CLI operations may change settings or erase knowledge, with what approval. Recommended starting point: prove the full path on Apple silicon, require all four advertised Host targets to pass independently before claiming parity, and authorize a single target per management operation. Keep cross-Host knowledge transfer out of this feature.

## Updates: knowing an update exists

Hosts report their own update status and the sidebar's update rows show it
([updates.md](updates.md#surfaces)). What is left:

- **Not decided:** one "Update both" action for Desktop and This Mac's service
  (service first, then Desktop), and opt-in automatic Host updates while no lane is
  working.
- **Priority repair on update.** An update restarts the service with `kickstart`, so a
  launchd job still at `ProcessType Background` stays there until a reinstall; the
  Host only logs a warning. Rewriting the job needs bootout/bootstrap, which can leave
  the service unloaded, and rollback cannot recover a missing job.

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
- Artifacts have indexes and version blobs (`libs/session-runtime/src/artifacts/artifact-library.ts`
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
  owns Host-side login, including the private terminal Settings → Accounts opens.
  Credentials never participate in copy or sync.

**Open questions.** Later sync needs per-primitive identities, revisions and
three-way comparison, deletion semantics and conflict UI. File merge may suit
skills, but not schedule activation or package upgrades. Decide whether artifact
copies fork history and how machine-specific paths are remapped.

**Risks.** Last-writer-wins can erase local edits, run a routine twice or leak MCP
secrets. Copy is not fleet management: each session and each routine scheduler
remains machine-local, consistent with AGENTS.md fact 5.

## Lane portability beyond bounded copies

[Move to…](lanes.md#moving-a-lane) copies saved lanes between folders and
machines, from Desktop and, between Hosts, from the browser. Follow-ups are
larger bundles and Host transcripts, submodule/LFS support, and a detailed
comparison of the target's skills, extensions, context files and MCP setup. The
current dialog acknowledges these configuration differences; it does not sync
them or promise provider cache hits.

This is a snapshot copy, not a single-writer handoff: the source remains intact
and the user chooses whether to delete it. Automatically retiring the source,
transferring unsaved work and resuming on a sleeping source need a separate
ownership protocol, not an extension of the copy operation.

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
same store), `features/settings/sections/connectors/useLocalConnectors.ts`,
`features/connectors/MigrationCard.tsx`, and a main-side credential-store
helper.

**Open questions.** Whether writing trust from a GUI needs pi's own command for
it rather than a file edit, and how the adapter named its keychain entries
across versions.

**Risks.** Trust lets a repository's config start local commands, so it must
stay an explicit, per-folder choice. Deleting the wrong keychain entry signs a
person out of something else.

## Host MCP connector extras

**Problem.** A Host's MCP Connectors share This Mac's view but not all of its
controls. They have no per-server test or tool names, no exposure or per-tool
rules, no edit in place, and no lane status (`caps.inspect` and `caps.edit` are
off for a Host, `useHostConnectors.ts`). A Host check is the reviewed aggregate
`pi mcp list --json`, and changing an entry means removing and adding it again.

**Proposed design.** Additive, granted settings contracts, one per feature:
`hosts:settingsCheck` with a server `name` and tool names in the result; an
`mcp.exposure` change carrying exposure and per-tool rules; `mcp.upsert` with
`replace: true`, which asks to approve a command connector's code again. Each
turns its capability on for Hosts that advertise it, and older Hosts keep
today's controls.

**Touches.** `libs/shared/src/machine-settings*.ts`, `apps/host/src/settings/`
(`connector-settings.ts`, `connector-check.ts`), `libs/shared/src/ipc/` hosts map,
`libs/host-client/src/settings.ts`, and the Host adapter.

**Open questions.** Whether a per-server check may start only that server's
command, and how long a lane reconnect may hold a Host lane.

**Risks.** Every extra check or replace is another way for a grant holder to
start code as the Host user, so each stays an explicit, reviewed step.

## Host Claude Code: versions and Test provider

A Host's Claude Code page shows whether the provider and the CLI are installed,
and installs them as reviewed tasks. It does not yet show their versions, offer
in-place updates, or run the one-click **Test provider** proof that This Mac
runs. Each needs an additive Host contract: an optional
`providers.claudeVersions` sibling (never new keys in `MachineClaude`, which old
clients parse strictly), and a `claude.test` machine task gated on a Host
capability. Until then a Host's source carries no `proof` and no version
fields, so the page hides them.

## Host package updates and version checks

**Problem.** A Host's Extensions section installs, updates and removes one
package at a time as reviewed tasks, but the Settings UI has no **Update all** or
registry version check (`caps.updateAll` and `caps.versionCheck` are false in
`useHostPackages.ts`). Update is offered on every installed package, because
the client cannot tell whether a newer version exists.

**Proposed design.** Two additive pieces, each behind a Host capability:
a `package.updateAll` machine task that runs `pi update --extensions` as one
reviewed task, and an optional `latest` version field on Host package rows,
filled from a registry lookup that never blocks the listing. Older Hosts keep
today's per-package controls.

**Touches.** `libs/shared/src/machine-settings*.ts`, `apps/host/src/settings/`
(the resources snapshot and package tasks), `libs/host-client/src/settings.ts`,
and `useHostPackages.ts`.

**Risks.** Update all starts code from every package source at once, so it
stays one explicit, reviewed task, never a background refresh.
