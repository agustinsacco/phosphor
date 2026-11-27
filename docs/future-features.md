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
- **`owner.print`.** A fixed-purpose owner call for Brain’s model runs. Today Desktop owns those ephemeral print processes; registering Brain recall does not give the service general-purpose print access.

## Updates: knowing an update exists

The Software pipeline (Settings → Advanced, [updates.md](updates.md)) updates This
Mac's service and every Host. What is not built is learning that an update exists
without opening Settings:

- **A Host reports its own update status.** The Host checks its signed release
  manifest in the background (the check `update/handoff.ts` already does, no
  download), a few minutes after start and then every few hours, and reports an
  additive `machine.status` `data.update { available?, checkedAt?, last? }`, where
  `last` is the existing `update-result.json` (updated, rolled back, failed). Older
  Hosts fall back to "a newer version runs on another of your machines". No new op,
  frame or capability.
- **One update area, bottom-left, above the account row,** on Desktop and the PWA:
  a Desktop app row and a row for the machine in scope ("bee1 · Update available",
  then the pipeline's steps, then "Updated to X"), with an out-of-date mark on each
  machine in the switcher and the Machines page. Rows open that machine's Settings
  row, which holds the one confirm. Rules: the account row never moves, each step
  shows at least 600 ms, a reconnect never changes a row, nothing shows during app
  start.
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
