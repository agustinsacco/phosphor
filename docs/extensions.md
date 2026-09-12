# Extensions (pi packages)

pi's capability model is **packages**: npm/git/path bundles that contribute
extensions, skills, prompt templates and themes to every session. Phosphor
makes that manageable without leaving the app (install, inspect, remove,
configure) and bootstraps pi itself on a fresh machine.

Nothing here invents install semantics. **pi's own package manager does every
mutation**; Phosphor reads state and streams the CLI's output.

## pi package semantics (verified against pi 0.84.2)

| Scope     | Settings file               | npm install dir                       | git clone dir                   |
| --------- | --------------------------- | ------------------------------------- | ------------------------------- |
| `global`  | `~/.pi/agent/settings.json` | `~/.pi/agent/npm/node_modules/<name>` | `~/.pi/agent/git/<host>/<path>` |
| `project` | `<ws>/.pi/settings.json`    | `<ws>/.pi/npm/node_modules/<name>`    | `<ws>/.pi/git/<host>/<path>`    |

- Entries live in the `packages` array as a spec string (`npm:pkg@1.2.3`,
  `git:github.com/u/r@ref`, `/abs/path`, `./rel/path`) or the object form
  `{source, extensions?, skills?, …}` for per-resource filtering.
- Local path specs are stored **relative to the settings file's directory**.
- pi loads **both** scopes; a project array does not shadow the global one.
- Declaring a package is enough: pi installs missing ones at session start.
  `installed: false` in the UI means "declared, arrives next session".
- Package contents come from the `pi` manifest in `package.json`, else from
  convention dirs (`extensions/`, `skills/`, `prompts/`, `themes/`).
- Exit codes are meaningful: `pi install` on a bad spec exits 1 and leaves
  settings untouched; `pi remove` on an unknown spec is a no-op.
- Phosphor never parses `pi list`; it reads the settings files and install
  dirs directly.

## Rules

- **Mutations shell out to pi** (`pi install [-l]`, `pi remove [-l]`,
  `pi update --extensions`), never hand-edited settings. That buys version
  pinning, git-ref reconciliation, `npmCommand` wrappers and eager installs for
  free. Project scope adds `-l` and runs with `cwd = workspace`.
- **Reads are file-based** and spawn nothing, so the tab renders instantly and
  works with no pi binary present.
- Renderer sends scope enums and spec strings; every path is resolved in
  `electron/pi/packages.ts`.
- Packages execute arbitrary code in pi's process. The tab says so. The
  catalogue is limited to specs whose source we have read, but every entry is a
  bare spec, so installing one takes whatever `latest` is. The review is of a
  package, not a version.

## Job streaming

Package mutations are long-running with output worth watching, so they use the
pty channel pattern rather than request/response:

```
packages:run(action, spec, scope, ws?) → { jobId }
  → chunks on  packages:output:<jobId>
  → exit code on packages:exit:<jobId>
```

`usePackageJob` owns one job at a time (`start()`, `output`, `exitCode`,
`running`, an on-exit refresh). `start()` takes any call returning `{ jobId }`,
so one hook powers the Extensions tab, the MCP adapter card, the Headroom
install, onboarding and the Claude provider test.

`packages:installPi` runs `npm install -g @earendil-works/pi-coding-agent`
through `piProcessEnv()` (login-shell PATH, so fnm/nvm work from a GUI launch)
and reports plainly when npm itself is unreachable.

## Surfaces

**Settings → Extensions.** Curated catalogue cards, then installed packages by
scope (name, version, spec, resource counts, `filtered` badge, remove), then
add-by-spec with a scope selector and "Update all". A link to
[pi.dev/packages](https://pi.dev/packages) for the ecosystem.

**Curated catalogue** (`src/features/settings/catalogue.ts`): five specs we
have read the source of: the Claude Code provider, the MCP adapter, web access,
subagents, computer use. An entry may declare `requiresBinary: 'claude'`,
which greys the card and says why when the binary is missing.

**Per-extension tabs.** Curated extensions get real config UIs, registered in
`EXTENSION_TABS` (`SettingsModal.tsx`) and shown **only while their package is
present**. They render nested under the Extensions entry, since they configure
an installed package; a stale sub-tab falls back to the Extensions list.

| Tab          | Package                      | Contents                                                                                                                       |
| ------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code  | `@saccolabs/pi-claude-cli`   | health card (package / `claude` binary / account), tested-version warning, **Test provider** one-click proof, failure playbook |
| Web access   | `pi-web-access`              | seven common search-provider keys (password fields, `$ENV_VAR` support), raw JSON editor                                       |
| Computer use | `@injaneity/pi-computer-use` | what the tools do and the OS accessibility permissions macOS will not grant silently                                           |

**MCP Connectors renders in the same slot but is NOT in `EXTENSION_TABS`**: it
shows unconditionally, because its Advanced disclosure is where
`pi-mcp-adapter` gets installed. Gating it on the adapter would hide the only
surface that can produce the adapter. See [mcp.md](mcp.md).

`pi-subagents` has **no tab**: it is zero-config, so a catalogue card is the
whole story.

**First run.** `PiMissingScreen` offers one-click Install/Update pi with
streamed output and an auto re-check. A successful install lands on
`GettingStartedScreen`: provider guidance plus the same catalogue cards.

## Command approval dialogs

A permission gate is an extension that hooks `tool_call`, decides a `bash`
command is dangerous and asks through `ctx.ui.select` / `ctx.ui.confirm`. What
arrives is an ordinary `extension_ui_request` whose title is **prose the
extension wrote, with the whole command inside it**. Rendered generically, a
60-line heredoc becomes a dialog _title_.

`src/features/extension-ui/commandApproval.ts` claims those dialogs and
`CommandApprovalSheet.tsx` renders them as a review surface. Two pure steps:

- **`parseCommandApproval`** recognises the shape (a heading naming a
  command, the command, a trailing `Allow?` / `Proceed?`, and for a `select`
  options that clearly mean yes and no). Tolerant on purpose: gates are
  third-party. A miss falls through to the generic dialog, which caps and
  scrolls its title.
- **`analyzeCommand`** says which part is dangerous and why. The gate never
  tells us (its answer is a boolean), so Phosphor re-derives the risk from the
  same pattern classes gates match on (`rm -rf`, `sudo`, force-push,
  `chmod 777`, …). It can name a risk the gate did not fire on, and it can
  find nothing; `risks.length === 0` is a real state and the sheet says so.

**A match's `context` is the point.** `command` means it runs. `heredoc` and
`quoted` mean the text is being written to a file or passed as an argument,
which is the biggest source of "why is this dangerous?". Incidental matches
are marked, never coloured like a live one.

Rules the sheet keeps:

- **Answer in the gate's own words.** A `select` response echoes the option
  string the gate offered, never an invented one.
- **Deny is the safe answer**, so it holds focus, Escape denies, and the
  backdrop does not dismiss. Nothing approves on a keypress.
- **The panel is height-capped and scrolls.** Over 14 lines it opens folded to
  the flagged lines.

`src/dev/mockPhosphor.ts` raises one in the browser harness when a prompt
starts with `danger`.

## Foreign config files

Some packages keep config outside pi's settings. Phosphor mirrors each
package's own resolution rather than guessing:

- `pi-web-access` → `web-search.json` from `PI_CODING_AGENT_DIR`, then
  `XDG_CONFIG_HOME/pi`, then **`~/.pi`** (not `~/.pi/agent`). Mirrored by
  `webSearchConfigPath()` in `pi-paths.ts`.
- Structured writes merge-patch and **refuse to write over a malformed file**;
  the tab disables its fields and points at the raw editor.

## Code map

- Main: `electron/pi/packages.ts` (spec classification, install-dir
  resolution, resource discovery, job runner, `claudeStatus`).
- IPC: `packages:list / run / installPi / checkUpdates / detect /
claudeStatus / claudeCliLatest / updateClaudeCli / testClaudeProvider`
  (`electron/ipc/packages-handlers.ts`); `pi:webSearchConfig /
patchWebSearchConfig` (`pi-config-handlers.ts`).
- UI: `tabs/ExtensionsTab.tsx`, `tabs/ClaudeProviderTab.tsx`,
  `tabs/WebAccessTab.tsx`, `tabs/ComputerUseTab.tsx`, `CatalogueCards.tsx`,
  `catalogue.ts`, `usePackageJob.ts`, `JobOutput.tsx`, `app/PiMissingScreen.tsx`,
  `app/GettingStartedScreen.tsx`. Mock cases in `src/dev/mockPhosphor.ts`.

## Bundled extensions (Phosphor's own)

Separate from packages the user installs, Phosphor ships **six** TypeScript
extensions in `pi-ext/`, loaded into **every** session via
`pi --mode rpc -e <path>` (`bundledExtensions()` in
`electron/ipc/pi-session-handlers.ts`). They are the only Phosphor code with a
say inside a turn.

| File                   | Why it must run inside pi                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `artifacts.ts`         | registers the artifact tools (see below)                                                     |
| `context-breakdown.ts` | measures context composition — the parts are only visible in-process                         |
| `worktree-paths.ts`    | refuses a file read that has escaped a worktree into the main checkout                       |
| `tool-name-guard.ts`   | rewrites a malformed tool call before pi persists it and bricks the thread                   |
| `mcp-status.ts`        | forwards the MCP adapter's per-server status off pi's shared event bus                       |
| `headroom.ts`          | compresses large tool results through a local Headroom proxy at the moment they are produced |

### The artifact tools, and what each one costs

`artifacts.ts` registers five tools. The split exists because an artifact's
token cost is **entirely the arguments the model writes**: the payload riding
in `details` never reaches the model and is free. What is not free is
resending a document to change part of it.

| Tool              | Cost                             | Use                                       |
| ----------------- | -------------------------------- | ----------------------------------------- |
| `artifact_create` | the whole document               | new artifact                              |
| `artifact_edit`   | just the changed region          | **the default way to revise**             |
| `artifact_update` | the whole document, again        | rewrites that touch most of the content   |
| `artifact_read`   | the whole document, into context | recovering text after compaction, to edit |
| `artifact_list`   | ids and sizes only               | recovering ids after compaction           |

One artifact plus two full rewrites costs ~55k output tokens; the same
nine-line change through `artifact_edit` is ~116.

`artifact_edit` follows Claude Code's `Edit` semantics: exact match, unique
unless `replace_all`, and a no-op is an error rather than a silent new version.
It never uses `String.replace`, whose `$&` / `$1` expansion would corrupt any
`new_string` containing them.

**`artifact://<id>` is a link the model can write in chat.** `artifactUrlTransform`
is handed to `ReactMarkdown` as `urlTransform` (its default filter would blank
the href), then `classifyLink` resolves the id against the active session's
artifacts and `MarkdownLink` opens the pane on it. `#v2` / `@v2` opens one
version; an unknown id toasts. `remarkArtifactLinks` also promotes the
inline-code and bare forms models actually write (`` `artifact://x` ``) into
links, keeping the `<code>` look.

`session_start` rebuilds the full artifact record, content included, because
an edit has to apply to the live text in a resumed session.

**Artifacts execute JavaScript, on their own origin.** They are NOT rendered
with `srcdoc`: a srcdoc document inherits the app's policy container, so the
app CSP refuses every inline script and the sandbox attribute becomes a no-op.
`electron/artifacts/artifact-protocol.ts` serves staged HTML over
`phosphor-artifact://` with its own `default-src 'none'` policy, and the iframe
keeps `sandbox="allow-scripts"` **without** `allow-same-origin`, which keeps
the origin opaque. Measured, not assumed: scripts run; storage, cookies,
parent and sibling DOM, top navigation, `fetch`, `sendBeacon`, WebSocket,
remote images and form POSTs are all refused. Never add `allow-same-origin`,
and never add a `connect-src`. Either one hands model-authored HTML a channel
out.

**The look of an artifact is injected, not prompted.**
`electron/artifacts/artifact-skeleton.ts` wraps the model's markup in a real
document with the house stylesheet in its `<head>`, so the model writes a
fragment and no palette. It is retroactive (rebuilt on every stage, so old
artifacts render in the current style); the model's own `<style>` still wins
(the sheet is a floor, not a cage); and the theme is Phosphor's, not the OS's
(`data-theme` is stamped from the renderer's resolved theme). Two rules the
sheet cannot enforce ride in the tool description: charts are hand-authored
inline SVG (the CSP grants no network, so a CDN chart library renders nothing),
and a chart carrying a claim gets a `table.data` under it. Row primitives
(`.ledger`, `.steps`, `.rail`) are column grids guarded by `:has()` on their
cell classes, so a row of prose degrades to a paragraph instead of word-wide
columns.

**The PDF export prints the staged document, not a second one.**
`electron/artifacts/artifact-pdf.ts` calls the same `stageArtifactHtml`, loads
the `phosphor-artifact://` URL in a hidden sandboxed window and `printToPDF`s
it, so the sheet, the theme stamp and the CSP are the preview's. The version it
replaces built its own document: a hand-copied subset of the sheet that knew
nothing of `.kpis`, `table.data` or `.ledger`, `marked` and `mermaid` from a CDN
(the CSP refuses exactly that), a hardcoded dark theme, and a page measured
1200px wide but printed 816px wide, which pushed the tail of a long artifact off
the bottom. Two document builders is one too many. The types the renderer draws
— markdown, mermaid, chart, code — have no main-process renderer at all, so the
pane serialises its rendered preview instead
(`src/features/artifacts/previewHtml.ts`: canvases become `data:` images,
buttons are dropped) and hands that over as the markup to stage.

Every tool an extension registers should declare at least one **required**
parameter. A call with no arguments reaches pi as `arguments: ""` on the
Claude Code provider, and pi validates before `execute`, so an all-optional
schema fails every call with `root: must be object`.

`worktree-paths.ts` is the only Phosphor code that can refuse a tool call. A
worktree session's cwd contains the main checkout as a prefix, and models
rebuild absolute paths from what they think the project root is, so a session
in `.phosphor/worktrees/<name>` was reading files off a different branch.
`tool_call` is the one hook that sees the path before the file is opened. The
rule is deliberately four-condition narrow (worktree session, path outside
cwd, path inside the main checkout, counterpart exists in cwd) because pi's own
system prompt sends the model to absolute paths outside the cwd for its docs.

`context-breakdown.ts` exists because pi reports context usage as one number,
and the composed system prompt and active tool schemas are not reachable from
the renderer. Two traps: `getAllTools()` returns definitions (the schemas that
occupy context) while `getActiveTools()` returns **names**; and it publishes at
rest (`session_start`, `agent_settled`, `turn_end`), never mid-stream. It
attributes MCP schema cost **per server** using the adapter's server names
from pi's shared event bus (`pi-mcp-adapter/status/v1`).

`mcp-status.ts` exists for the same reason in the other direction: the adapter
publishes each server's state on that bus, but pi's RPC has no channel for it.
It forwards the snapshot verbatim.

### The status channel is a wire contract

Bundled extensions and provider packages talk to Phosphor's UI the same way:
`ctx.ui.setStatus(key, text)` → pi's extension-UI request → the per-session map
in `stores/extensionUi.ts`. Five keys are load-bearing, and the key strings are
**case-sensitive literals on both sides**; nothing fails to compile when they
disagree.

| Key                          | Emitter                             | Consumer                                                                                                          |
| ---------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `phosphor-context-breakdown` | `pi-ext/context-breakdown.ts`       | `chat/composer/contextBreakdown.ts` → ContextMeter                                                                |
| `phosphor-mcp-status`        | `pi-ext/mcp-status.ts`              | `connectors/mcpStatus.ts` → Connectors, footer                                                                    |
| `phosphor-headroom`          | `pi-ext/headroom.ts`                | `chat/composer/headroomStatus.ts` → ContextMeter (Optimization section)                                           |
| `claude-rate-limit`          | `@saccolabs/pi-claude-cli` ≥ 0.4.5  | `chat/composer/rateLimit.ts` → ContextMeter, RateLimitBanner; `shared/claude-limits.ts` → account routing in main |
| `claude-subagents`           | `@saccolabs/pi-claude-cli` ≥ 0.4.13 | `chat/subagentStatus.ts` → the status strip's agent chip (see the sub-agent section below)                        |

The two `claude-*` keys cross a repo boundary; their shape is documented on the
emitting side in that repo's `docs/ARCHITECTURE.md`. Rules for all five: the
payload is JSON in a string, every parser returns `null` rather than throwing,
and a missing key means "render nothing", never an empty section. A structured
key must also be listed in `STRUCTURED_STATUS_KEYS`
(`features/extension-ui/ExtensionUiHosts.tsx`) or the status strip prints its
JSON as prose. Status pushes must never be able to break a turn, so emitters
swallow their own errors.

## How provider transcripts render

The Claude Code provider's sessions contain block shapes pi itself never
emits, so the transcript layer has provider-specific handling
(`items/transcriptRows.ts`; contract table in
[chat.md](chat.md#blocks-from-the-claude-code-provider)).

- **CLI-side tools** (WebSearch, WebFetch, ToolSearch, the user's own MCP
  servers, sub-agents) run _inside_ the CLI, so pi never sees them as tool
  calls. The provider reports each as a `[Claude Code · Name {args}]` marker;
  Phosphor parses it into an `externalTool` activity step.

  **They render in pi's vocabulary.** `summarizeExternalTool` maps the marker's
  tool name onto the same verbs pi's own tools get (`Bash` → `Ran`, `Grep` →
  `Searched for`), with the same monospace treatment and the same
  operative-line labelling. A Claude-provider turn interleaves these rows with
  pi's, and two vocabularies made one turn read as two transcripts. Provenance
  survives as a small `cc` mark in the row gutter (absolute, reserving no
  column, sharing a slot with the ✳ reasoning mark) plus the full marker in
  the row's `title`. An unrecognised tool keeps its NAME as the emphasis;
  `mcp__linear__save_issue` says more than any verb we could invent.

  **What the row may claim is bounded by what the markers carry.** With
  `PI_CLAUDE_CLI_TOOL_RESULTS=1` set on every session, the provider tags each
  call with its `tool_use_id` and follows it with a
  `[Claude Code · result #<id> {…}]` marker. A tagged call is a promise of a
  result, so those rows go through the same three states a pi tool row does
  (running, settled with an outcome, failed) and expand into the output.
  `buildTranscriptRows` folds the result into the row its call produced; the
  pairing outlives a message, and a result marker is **never a row of its
  own**. An UNTAGGED call keeps the older shape: no chevron, no status, always
  settled, because a chevron that opens onto nothing is a promise the
  transcript cannot keep.

  The outcome line is the provider's own `summary`; Phosphor measures nothing.
  Provider ≥ 0.8.0 builds it from the CLI's structured result (`419 lines`,
  `+1 -1 in poem.txt`, `exit 1 · ls: /nope: No such file or directory`);
  0.6.0–0.7.1 sends only `{status, preview, length}`, and the row shows the
  status with an expandable preview and no outcome line.

  **The argument preview is complete JSON on provider ≥ 0.8.0**, and a
  document cut at 120 characters below it. That cut often lands inside the
  value, so `externalToolInfo` also recovers the final unterminated value,
  unescaping defensively. That recovery stays for sessions recorded before
  0.8.0; they are on disk forever.

- **Encrypted thinking**: a signature with no plaintext. Skipped on settled
  items.

- **Sub-agents**: `Agent`/`Task` markers render as sub-agent rows (badge,
  description, status, cost, expandable prompt).

  **One row per AGENT, not per marker.** The CLI reports the same agent three
  times (the `Agent` tool call, `Task started`, `Task completed`).
  `buildTranscriptRows` folds them by `task_id` when the provider sends one
  (0.4.14+), otherwise by pairing phases under one description.

  **The row's STATUS claims only what the markers prove.** `launched` means
  the model called the tool and the CLI never confirmed anything; `running`
  means a `task_started` arrived; a terminal status carries tool count, tokens
  and duration. The sub-agent's own transcript is not forwarded, so the
  expandable detail is the launch PROMPT.

  **Its PROGRESS is joined live from the status channel**, by `taskId`. A
  sub-agent produces exactly two markers, so a marker-only row could not
  change for its whole life. `findLiveSubagent` (`chat/subagentStatus.ts`) is
  the join; `SubagentRow` renders the step and the climbing cost. The overlay
  only ADDS to a LIVE row: it never moves a status and is skipped once the row
  is terminal.

  **Background agents used to die, and old sessions still show it.** Until
  provider 0.4.14 the provider killed `claude -p` at the turn's first
  `result`, which for a background agent lands while it is still working.
  Phosphor pins no version, so both shapes keep arriving:
  `trailingUnfinishedAgents` counts agents that never reached a terminal
  state, and only those raise the "never reported back" strip.
  `PI_CLAUDE_CLI_SETTINGS` → `--settings` with `permissions.deny: ["Agent","Task"]`
  is the hard block.

  **Live progress rides the status channel, not the transcript.**
  `task_progress` fires once per sub-agent tool call, so the provider publishes
  a snapshot on `claude-subagents` instead, parsed into the strip's chip and
  each row's step. That key MUST stay in `STRUCTURED_STATUS_KEYS`. The
  provider clears it when the episode ends, so a finished turn leaves the chip
  empty.

  Sub-agent **spend** is visible from provider 0.4.10, which bills from
  `result.modelUsage` (every model, sub-agents included) rather than
  `result.usage` (the main agent alone).

**If you extend this** (tool request/response UX, live sub-agent trees): the
provider drops the `tool_result` blocks the CLI feeds itself between cycles.
Surfacing more needs a provider change first, then a step kind here. Do not
infer it from the marker stream.

**The sub-agent's own work IS on disk.** The CLI writes each sub-agent a
complete, live-appended transcript at
`~/.claude/projects/<mangled-cwd>/<session-id>/subagents/agent-<taskId>.jsonl`,
with an `agent-<taskId>.meta.json` sidecar (`agentType`, `toolUseId`,
`spawnDepth`, `parentAgentId` for nested agents). `taskId` is the join;
`pi-paths.ts` exposes `claudeProjectDirForCwd()`. Two traps: do not resolve
the directory from the session's current `claudeSessionId` (it rotates on
resume; glob `<projectDir>/*/subagents/agent-<taskId>.jsonl` instead), and
`outputFile` only arrives at the terminal event, so it cannot back a live view.

## Sharp edges

- **The e2e stub is also a package manager.** `e2e/fixtures/pi-stub.cjs`
  dispatches on argv before any RPC setup: `install`/`remove` edit the
  sandboxed settings.json and mirror the npm dir layout; `-p` answers print
  mode. An install must never create a stub session.
- **Two gated env hooks**, both `!app.isPackaged` (an env var must not become
  code execution in a shipped app): the stub override for package jobs, and
  `PHOSPHOR_CLAUDE_BIN` for the Claude health probes.
- **`claude auth status` is local-only**, so the provider tab may probe it on
  mount. The `Test provider` run is not free (it spends a little plan quota),
  so it stays behind a button.
- Settings edits apply to **new sessions**; pi reads config at spawn. Every
  mutating surface says so.

## The Claude Code provider

`@saccolabs/pi-claude-cli` (our fork of `rchern/pi-claude-cli`) makes Claude
Pro/Max subscription models available inside pi's own agent loop by driving the
Claude Code CLI as a model server. Phosphor treats it as an ordinary package;
`shared/rpc.ts` needed no changes. Its internals are documented in that repo's
`docs/ARCHITECTURE.md`; the Phosphor-side contract is
[cli-providers.md](cli-providers.md).

### Two versions go stale, and only one of them is pi's

Settings → Extensions → **Claude Code** checks both, because they drift apart
and each looks fine from the other's row:

- **`@saccolabs/pi-claude-cli`** is a pi package, covered by
  `packages:checkUpdates` and updated through `pi update`.
- **The `claude` CLI itself** is not. The tab reads `claude --version`, asks
  the npm registry for `@anthropic-ai/claude-code`'s `latest`, and offers
  **Update** when the installed one is older.

The update runs `claude update`, **not** `npm install -g`. A 2.x install from
the official script is a native build under `~/.local/share/claude/versions/`
with a symlink in `~/.local/bin`; npm does not own it, and `npm install -g`
would leave that symlink pointing at the old build. `claude update` handles
both layouts.

### Updating the CLI does not add new models

The model list under the `pi-claude-cli` provider does **not** come from the
CLI. The package builds it from `getBuiltinModels("anthropic")`, pi's own
bundled catalogue. A model Anthropic shipped yesterday appears in the picker
when **pi** updates, not when Claude Code does.

There is no user-side override. In pi's provider composer, an extension that
registers a `models` array **replaces** the list outright, so a `models.json`
entry for `pi-claude-cli` is discarded and `modelOverrides` cannot add one
either. The fix belongs in the provider package.
