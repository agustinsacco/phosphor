# Extensions (pi packages)

pi's capability model is **packages**: npm/git/path bundles that contribute
extensions, skills, prompt templates and themes to every session. Phosphor's
job is to make that ecosystem manageable without leaving the app — install,
inspect, remove, configure — plus bootstrap pi itself on a fresh machine.

Nothing here invents install semantics: **pi's own package-manager CLI does
every mutation**, Phosphor only reads state and streams the CLI's output.

## pi package semantics (verified against pi 0.84.2)

| Scope     | Settings file               | npm install dir                       | git clone dir                   |
| --------- | --------------------------- | ------------------------------------- | ------------------------------- |
| `global`  | `~/.pi/agent/settings.json` | `~/.pi/agent/npm/node_modules/<name>` | `~/.pi/agent/git/<host>/<path>` |
| `project` | `<ws>/.pi/settings.json`    | `<ws>/.pi/npm/node_modules/<name>`    | `<ws>/.pi/git/<host>/<path>`    |

- Entries live in the `packages` array as a spec string (`npm:pkg@1.2.3`,
  `git:github.com/u/r@ref`, `/abs/path`, `./rel/path`) **or** the object
  form `{source, extensions?, skills?, …}` for per-resource filtering.
- Local path specs are stored **relative to the settings file's directory**
  (`~/.pi/agent`), so `../../../pkg` resolves to `~/pkg` — not to `~/.pi`.
- pi loads **both** scopes; a project array does not shadow the global one.
- Declaring a package is enough: pi installs missing ones at session start.
  `installed: false` in the UI means "declared, arrives next session".
- Package contents are declared by the `pi` manifest in `package.json`, else
  discovered from convention dirs (`extensions/`, `skills/`, `prompts/`,
  `themes/`). Manifest globs are shown as written; `!exclusions` dropped.
- Exit codes are meaningful: `pi install` on a bad spec exits 1 and leaves
  settings untouched; `pi remove` on an unknown spec is a friendly no-op.
- `pi list` is human-oriented — Phosphor never parses it, it reads the settings
  files and install dirs directly.

## Rules

- **Mutations shell out to pi** (`pi install [-l]`, `pi remove [-l]`,
  `pi update --extensions`), never hand-edited settings. That buys version
  pinning, git-ref reconciliation, `npmCommand` wrapper support and eager
  installs for free. Project scope adds `-l` and runs with `cwd = workspace`.
- **Reads are file-based** and never spawn anything, so the tab renders
  instantly and works with no pi binary present.
- Renderer sends scope enums and spec strings; every path is resolved in
  `electron/pi/packages.ts`.
- Packages execute arbitrary code in pi's process. The tab says so, the
  catalogue pins reviewed versions, and project-scope packages ride pi's own
  trust prompt.

## Job streaming

Package mutations are long-running with output worth watching, so they use
the pty channel pattern rather than a request/response:

```
packages:run(action, spec, scope, ws?) → { jobId }
  → chunks on  packages:output:<jobId>
  → exit code on packages:exit:<jobId>
```

`usePackageJob` (renderer) owns one job at a time: `start()`, accumulated
`output`, `exitCode`, `running`, and an on-exit callback that refreshes the
list. `JobOutput` renders the stream with a state dot. The same hook powers
the Extensions tab, the MCP adapter card, onboarding, and the Claude
provider test — one mechanism, four surfaces.

`packages:installPi` runs `npm install -g @earendil-works/pi-coding-agent`
through `piProcessEnv()` (login-shell PATH, so fnm/nvm work from a GUI
launch) and reports a clear failure when npm itself is unreachable.

## Surfaces

**Settings → Extensions.** Curated catalogue cards, then installed packages
grouped by scope (name, version, spec, resource counts, `filtered` badge,
remove), then add-by-spec with a scope selector and "Update all". A link to
[pi.dev/packages](https://pi.dev/packages) for the full ecosystem.

**Curated catalogue** (`src/features/settings/catalogue.ts`): a static list
of specs we have read the source of. Entries may declare
`requiresBinary: 'claude'`, which greys the card and explains why when the
binary is missing (`packages:detect`).

**Per-extension tabs.** Curated extensions get real config UIs, registered
in `EXTENSION_TABS` (`SettingsModal.tsx`) and shown **only while their
package is present** — the list re-reads `packages:list` on every modal
open, so installing from the Extensions tab reveals a tab immediately.

They render **nested under the Extensions entry** in the settings sidebar
(indented sub-entries, guide line), not as top-level tabs: they configure an
installed package, so they belong to the package list. The Extensions entry
stays highlighted while a sub-tab is active, and a stale sub-tab (package
removed out-of-band) falls back to the Extensions list instead of rendering
an orphaned panel.

| Tab         | Package                    | Contents                                                                                                                       |
| ----------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code | `@saccolabs/pi-claude-cli` | health card (package / `claude` binary / account), tested-version warning, **Test provider** one-click proof, failure playbook |
| Web access  | `pi-web-access`            | seven common search-provider keys (password fields, `$ENV_VAR` support), raw JSON editor                                       |
| MCP         | `pi-mcp-adapter`           | see [11-mcp.md](mcp.md)                                                                                                        |

`pi-subagents` deliberately has **no tab**: it is zero-config by design, so
a catalogue card is the whole story.

**First run.** `PiMissingScreen` offers one-click Install/Update pi with
streamed output and an auto re-check (the copyable command stays as a
fallback). A successful install lands on `GettingStartedScreen`: provider
guidance (subscription `/login` in a terminal, API keys → Agent tab) plus
the same catalogue cards, then Continue.

## Command approval dialogs

A permission gate is an extension that hooks `tool_call`, decides a `bash`
command is dangerous and asks the user through `ctx.ui.select` /
`ctx.ui.confirm`. Phosphor has no special protocol for this: what arrives is an
ordinary `extension_ui_request` whose title is **prose the extension wrote,
with the whole command inside it**. Rendered generically, a 60-line heredoc
became a dialog _title_ — unwrapped, unscrollable, off both edges of the
screen, with nothing marking which four characters tripped the gate.

`src/features/extension-ui/commandApproval.ts` claims those dialogs and
`CommandApprovalSheet.tsx` renders them as a review surface. Two pure steps:

- **`parseCommandApproval`** recognises the shape — a heading line naming a
  command, the command, a trailing `Allow?` / `Proceed?` — and for a `select`
  also requires options that clearly mean yes and no. Tolerant on purpose:
  gates are third-party and their wording drifts. A miss falls through to the
  generic dialog, which now caps and scrolls its title rather than growing.
- **`analyzeCommand`** says which part is dangerous and why. **The gate never
  tells us** — its answer is a boolean — so Phosphor re-derives the risk from the
  same pattern classes gates match on (`rm -rf`, `sudo`, force-push,
  `chmod 777`, …). Two honest consequences: Phosphor can name a risk the gate did
  not fire on, and it can find nothing at all. `risks.length === 0` is a real
  state and the sheet says so instead of inventing a reason.

**A match's `context` is the point.** `command` means it runs. `heredoc` and
`quoted` mean the text is being written to a file or passed as an argument —
the single biggest source of "why is this dangerous?", because a script full
of `rm -rf` trips every gate on its way to disk. Incidental matches are
marked, never coloured like a live one, and a command whose every match is
incidental says so at the top.

Rules the sheet keeps:

- **Answer in the gate's own words.** A `select` response echoes the option
  string the gate offered (`Yes`, `Allow once`), never an invented one — the
  gate compares against what it sent.
- **Deny is the safe answer**, so it holds focus, Escape denies, and the
  backdrop does not dismiss. Nothing approves on a keypress.
- **The panel is height-capped and scrolls.** Over 14 lines it opens folded to
  the flagged lines with the rest one click away.

`src/dev/mockPhosphor.ts` raises a real one in the browser harness when a prompt
starts with `danger`, since the harness has no pi and therefore no gate.

## Foreign config files

Some packages keep config outside pi's settings. Phosphor mirrors each
package's own resolution rather than guessing:

- `pi-web-access` → `web-search.json` from `PI_CODING_AGENT_DIR`, then
  `XDG_CONFIG_HOME/pi`, then **`~/.pi`** (not `~/.pi/agent`). Mirrored by
  `webSearchConfigPath()` in `pi-paths.ts`, verified against that package's
  `utils.ts` at 0.24.0.
- Structured writes merge-patch and **refuse to write over a malformed
  file** (same contract as `settings.json`); the tab disables its fields and
  points at the raw editor instead.

## Code map

- Main: `electron/pi/packages.ts` (spec classification, install-dir
  resolution, resource discovery, job runner, `claudeStatus`) — unit tests
  in `electron/pi/packages.test.ts` using fixture dirs via
  `PI_CODING_AGENT_DIR`.
- IPC: `packages:list / run / installPi / detect / claudeStatus /
testClaudeProvider` (`electron/ipc/packages-handlers.ts`);
  `pi:webSearchConfig / patchWebSearchConfig` and the widened
  `pi:readConfigFile|writeConfigFile` union (`pi-config-handlers.ts`).
- Preload: `onPackagesJobOutput` / `onPackagesJobExit`.
- UI: `tabs/ExtensionsTab.tsx` (+ exported `JobOutput`),
  `tabs/ClaudeProviderTab.tsx`, `tabs/WebAccessTab.tsx`, `CatalogueCards.tsx`,
  `catalogue.ts`, `usePackageJob.ts`; `app/PiMissingScreen.tsx`,
  `app/GettingStartedScreen.tsx`. Mock cases in `src/dev/mockPhosphor.ts`.
- E2E (`e2e/smoke.spec.ts`): four tests — listing with a seeded fixture
  package, install/remove round-trip through the stub's package-manager
  mode, web-access key write, and the Claude provider chain.

## Bundled extensions (Phosphor's own)

Separate from packages the user installs, Phosphor ships its own pi extensions
as TypeScript files in `pi-ext/`, loaded into **every** session via
`pi --mode rpc -e <path>` (`bundledExtensions()` in
`electron/ipc/pi-session-handlers.ts`; the e2e stub gets none):

| File                   | Why it must run inside pi                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `artifacts.ts`         | registers the artifact tools (see below, and [07-artifacts.md](specs/build/07-artifacts.md)) |
| `context-breakdown.ts` | measures context composition — the parts are only visible in-process                         |
| `worktree-paths.ts`    | refuses a file read that has escaped a worktree into the main checkout                       |
| `tool-name-guard.ts`   | rewrites a malformed tool call before pi persists it and bricks the thread                   |
| `mcp-status.ts`        | forwards the MCP adapter's per-server status off pi's shared event bus                       |
| `headroom.ts`          | compresses large tool results through a local Headroom proxy at the moment they are produced |

### The artifact tools, and what each one costs

`artifacts.ts` registers five tools. The split exists for one reason: an
artifact's token cost is **entirely the arguments the model writes**. pi-ai's
`convertToolResult` reads only `content`, `toolCallId` and `isError`, so the
full payload riding in `details` never reaches the model and is free. What is
not free is resending a document to change part of it.

| Tool              | Cost                             | Use                                       |
| ----------------- | -------------------------------- | ----------------------------------------- |
| `artifact_create` | the whole document               | new artifact                              |
| `artifact_edit`   | just the changed region          | **the default way to revise**             |
| `artifact_update` | the whole document, again        | rewrites that touch most of the content   |
| `artifact_read`   | the whole document, into context | recovering text after compaction, to edit |
| `artifact_list`   | ids and sizes only               | recovering ids after compaction           |

Measured: one artifact plus two revisions cost ~55k output tokens, and the last
revision changed nine lines. The same change through `artifact_edit` is ~116
tokens.

`artifact_edit` follows Claude Code's `Edit` semantics — exact match, unique
unless `replace_all`, and a no-op is an error rather than a silent new version.
It must never use `String.replace`: even with a string pattern that expands
`$&`, `` $` ``, `$'` and `$1` in the _replacement_, which silently corrupts any
`new_string` containing them.

**`artifact://<id>` is a link the model can write in chat.** Two pieces make it
work, and both are required: `artifactUrlTransform` is handed to
`ReactMarkdown` as `urlTransform`, because react-markdown's default filter
rewrites any non-web protocol to `''` before a component ever sees the href;
then `classifyLink` (both in `src/lib/markdownLink.ts`) resolves it against the
active session's artifacts and `MarkdownLink` opens the Artifacts pane on it.
`#v2` / `@v2` opens one version, and an id this session never had raises a
toast instead of doing nothing. The id is slugified exactly as `slugifyArtifactId` slugifies it, so a
link written from the title still resolves. The tool description and the
`artifact_create` result both name the syntax, because models were already
inventing this link and every one of them was inert.

**It does not have to be written as a markdown link.** Models reference an
artifact most often as inline code (`` `artifact://phosphor-beacon` ``, because
the URL reads like an identifier) and sometimes bare in prose; GFM autolinks
only www/http/mailto, so both forms stayed dead text.
`remarkArtifactLinks` (`src/lib/remarkArtifactLinks.ts`, the last remark plugin
in `Markdown.tsx`) promotes both into link nodes before rendering — the
inline-code one keeps its `<code>` child, so it still looks like code and
merely becomes clickable. A code span that only mentions a URL among other
words is left alone, and trailing punctuation is never part of the id.

`session_start` rebuilds the full artifact record — content included, not just
version numbers — because an edit has to apply to the live text in a resumed
session.

**Artifacts execute JavaScript, on their own origin.** They are NOT rendered
with `srcdoc` — a `srcdoc` document inherits the embedder's policy container,
so `script-src 'self'` from `src/index.html` refused every inline script and
the `sandbox="allow-scripts"` attribute was a no-op. `blob:` and `data:`
inherit the same way. `electron/artifacts/artifact-protocol.ts` serves staged
HTML over `phosphor-artifact://` with its own `default-src 'none'` policy, and the
iframe keeps `sandbox="allow-scripts"` **without** `allow-same-origin`, which
keeps the origin opaque. The result is measured, not assumed: scripts run;
storage, cookies, parent and sibling DOM, top navigation, `fetch`,
`sendBeacon`, WebSocket, remote images and form POSTs are all refused. Never
add `allow-same-origin`, and never add a `connect-src` to that policy — either
one hands model-authored HTML a channel out. See
[docs/log/2026-08-28-lane-management-and-artifact-edits.md](log/2026-08-28-lane-management-and-artifact-edits.md).

**The look of an artifact is injected, not prompted.**
`electron/artifacts/artifact-skeleton.ts` wraps the model's markup in a real
document and puts the house stylesheet in its `<head>`, so the model writes a
fragment and no palette at all. Three consequences worth knowing:

- **It is retroactive.** The document is rebuilt on every stage, so an artifact
  written weeks ago re-renders in the current style.
- **The model still wins.** Its `<style>` lands after the sheet in document
  order; the sheet is a floor, not a cage.
- **The theme is Phosphor's, not the OS's.** `data-theme` is stamped on the
  root element from the renderer's resolved theme (which is why
  `artifacts:stageHtml` takes it as an argument — the staged content depends on
  it, so the caller needs a dependency to re-stage on), and `main.ts` sets
  `nativeTheme.themeSource` so the `prefers-color-scheme` path agrees. Before
  this, nothing wrote `data-theme` anywhere, and an artifact followed macOS
  while the app followed its own preference.

Two rules the sheet cannot enforce, so the tool description carries them:
charts are **hand-authored inline SVG** (the artifact CSP grants no network, so
a CDN chart library renders nothing at all), and any chart carrying a claim gets
a `table.data` under it. See
[docs/log/2026-09-08-artifact-house-style.md](log/2026-09-08-artifact-house-style.md).

**A row primitive is a column grid, and the sheet only engages it for its own
cells.** `.ledger>.row`, `.steps>.s` and `.rail>.node` lay out one grid item per
inline child, so a row of free prose was sliced into word-wide columns; each of
those tracks is now behind a `:has()` guard on the cell classes, and a prose row
degrades to a paragraph. `table.data` asks for `min-width:min(100%,30rem)` — the
flat `30rem` it replaces forced a horizontal page scroll in a panel narrower
than that. The width budget is the reason the tool description caps a table at
five columns. See
[docs/log/2026-09-09-artifact-tables-narrow-panel.md](log/2026-09-09-artifact-tables-narrow-panel.md).

`lane-loop.ts` used to sit here too — it ran a fixed ladder of checks when a
turn settled and published the result to a banner above the composer. Both the
extension and the banner were removed on 2026-08-28; the idea is meant to come
back in a different shape. See
[docs/log/2026-08-28-removing-the-lane-loop-pane.md](log/2026-08-28-removing-the-lane-loop-pane.md).

Every tool an extension registers should declare at least one **required**
parameter. A tool call carrying no arguments reaches pi as `arguments: ""` on
the Claude Code provider (no `input_json_delta` is streamed, so the bridge's
accumulated JSON is empty), and pi validates before `execute` runs — so an
empty-or-all-optional schema fails every call with `root: must be object` and
the extension never runs. See
[docs/log/2026-08-27-orchestrator-empty-tool-arguments.md](log/2026-08-27-orchestrator-empty-tool-arguments.md).

`worktree-paths.ts` is the only Phosphor code that can refuse a tool call. A
session in `.phosphor/worktrees/<name>` was observed reading files out of the main
checkout — a different branch — because the model rebuilds absolute paths from
what it thinks the project root is, and the worktree's cwd contains the main
checkout as a prefix. `tool_call` is the one hook that sees the path before the
file is opened, which is why this runs in pi rather than in the main process.
The rule is deliberately four-condition narrow (worktree session, path outside
cwd, path inside the main checkout, counterpart exists in cwd) because pi's own
system prompt sends the model to absolute paths outside the cwd for its docs.
Full account: [log/2026-08-22-worktree-path-leak.md](log/2026-08-22-worktree-path-leak.md).

`context-breakdown.ts` exists because pi reports context usage as one
number. The composed system prompt and the active tool schemas are not
reachable from the renderer at all, so measuring them has to happen inside
pi. Two traps it documents at its call sites, both of which produced wrong
numbers first: `getAllTools()` returns definitions (the schemas that
actually occupy context) while `getActiveTools()` returns **names** — using
the latter for sizing reports a handful of tokens for a tool set costing
thousands; and it publishes at rest (`session_start`, `agent_settled`,
`turn_end`), never mid-stream, because a per-delta recompute walks the whole
branch on every token. It also attributes MCP schema cost **per server**,
which needs the adapter's server names: those arrive on pi's shared event bus
(`pi-mcp-adapter/status/v1`), because the tool-name prefix alone cannot say
which server a tool belongs to under the adapter's default `toolPrefix`.

`mcp-status.ts` exists for the same reason in the other direction: the adapter
knows each server's state (connected / needs-auth / failed / cached /
disabled) and publishes it on that bus, but pi's RPC has no channel for it, so
without this extension a front-end can only read the adapter's one-line prose
footer. It forwards the snapshot verbatim — no rewording, no inference.

### The status channel is a wire contract

Both bundled extensions and provider packages talk to Phosphor's UI the same
way: `ctx.ui.setStatus(key, text)` → pi's extension-UI request → the
per-session map in `stores/extensionUi.ts`. Four keys are load-bearing today:

| Key                          | Emitter                            | Consumer                                                                                                     |
| ---------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `Phosphor-context-breakdown` | `pi-ext/context-breakdown.ts`      | `composer/contextBreakdown.ts` → ContextMeter                                                                |
| `Phosphor-mcp-status`        | `pi-ext/mcp-status.ts`             | `connectors/mcpStatus.ts` → Connectors, footer                                                               |
| `claude-rate-limit`          | `@saccolabs/pi-claude-cli` ≥ 0.4.5 | `composer/rateLimit.ts` → ContextMeter, RateLimitBanner; `shared/claude-limits.ts` → account routing in main |
| `Phosphor-headroom`          | `pi-ext/headroom.ts`               | `composer/headroomStatus.ts` → ContextMeter (Optimization section)                                           |

The last one crosses a repo boundary, so its shape is API — it is documented
on the emitting side in that repo's `docs/ARCHITECTURE.md`, and changing it
there breaks rendering here with no compile error. Rules for all three: the
payload is JSON in a string, every parser returns `null` rather than
throwing on garbage, and a missing key means "render nothing", never an
empty section. A structured key must also be listed in
`STRUCTURED_STATUS_KEYS` (`features/extension-ui/ExtensionUiHosts.tsx`) or the
status strip renders its JSON as prose. Status pushes must never be able to
break a turn — the emitters swallow their own errors for that reason.

## How provider transcripts render

The Claude Code provider is the first package whose sessions contain block
shapes pi itself never emits, so the transcript layer has provider-specific
handling (`items/transcriptRows.ts`, contract table in
[04-chat.md](chat.md#blocks-from-the-claude-code-provider)):

- **CLI-side tools** — WebSearch, WebFetch, ToolSearch, the user's own MCP
  servers, and Claude Code sub-agents run _inside_ the CLI, so pi never sees
  them as tool calls. The provider reports each as a
  `[Claude Code · Name {args}]` marker text block; Phosphor parses it into an
  `externalTool` activity step. Left as prose it wrapped raw JSON across
  paragraphs and markdown-linkified any URL inside it.

  **They render in pi's vocabulary, not Claude Code's.**
  `summarizeExternalTool` maps the marker's tool name onto the same verbs
  `summarizeTool` gives pi's own tools — `Bash` → `Ran`, `Grep` →
  `Searched for`, `Read` → `Read` — with the same monospace treatment and the
  same `commandHeadline` operative-line labelling (the row shows the line
  that does the work, not the `cd`/`echo` setup, with a `+N more` hint when
  a script ran more). A Claude-provider turn
  interleaves these rows with pi's, and showing `Claude Code | Bash | <raw
arg>` next to `Ran npm test` made one turn read as two transcripts.
  Provenance survives as a small `cc` mark plus the full marker in the row's
  `title`, because pi genuinely never saw these calls.

  **The `cc` mark floats in the row gutter (`GUTTER_MARK`), never inline.** It
  was an inline pill, which put a Claude row's label ~25px right of the pi tool
  row above it — and these rows interleave with pi's inside one card, so the
  shared inset (`ROW_INSET`) stopped meaning anything on the first WebSearch.
  Marks in the gutter are `absolute` and reserve no column, so every row shape
  — pi tool, CLI-side tool, sub-agent, reasoning — starts its label at the same
  x, and the ✳ reasoning mark and `cc` share one slot. Guarded by
  `items/activityGroupRows.test.tsx`.

  Two things are deliberately NOT borrowed, and both are honesty rather than
  polish: no chevron (there is no `tool_result`, so nothing to expand into)
  and no status (the marker arrives after the fact, so the row is always
  settled). An unrecognised tool keeps its NAME as the emphasis —
  `mcp__linear__save_issue` says more than any verb Phosphor could invent.

  **The argument preview is capped at 142 characters**, and the cap lands
  inside the value often enough to matter: `Bash` carries a single `command`,
  so a complete-`"key":"value"`-pair scan recovered nothing and 26 of 47 rows
  in one real turn rendered as a bare row with no command at all.
  `externalToolInfo` therefore also recovers the final UNTERMINATED value,
  unescaping defensively (a cut can land mid-`\uXXXX` or after a lone
  backslash). Guarded by `items/externalToolRealMarkers.test.ts`, which
  replays all 47 markers from that turn — synthetic fixtures kept missing
  this, because hand-written markers are short enough to survive the cap.

- **Encrypted thinking** — a signature with no plaintext, which rendered as a
  "thought" that expands to nothing. Skipped on settled items.

Both were quantified by replaying real sessions from all four Claude
families through Phosphor's own hydration and transcript builder; the fixture in
`chat/__fixtures__/claude-cli-blocks.json` is trimmed from those captures and
guards the behaviour (`items/claudeCliRendering.test.ts`).

- **Sub-agents** — `Agent`/`Task` markers render as sub-agent rows (badge,
  description, status, cost, expandable prompt).

  **One row per AGENT, not per marker.** The CLI reports the same agent three
  times: the model's `Agent` tool call, then `Task started`, then
  `Task completed`. Rendering each of them turned a three-agent fan-out into
  eight rows and a strip that said "8 sub-agents were started".
  `buildTranscriptRows` folds them — by `task_id` when the provider sends one
  (0.4.14+), otherwise by pairing markers of each phase under one description,
  which keeps three same-named parallel agents as three rows.

  **The row's STATUS claims only what the markers prove.** `launched` means the
  model called the tool and the CLI never confirmed anything; `running` means a
  `task_started` arrived; a terminal status carries the agent's tool count,
  tokens and duration. The sub-agent's own transcript is still not forwarded,
  so the expandable detail is the launch PROMPT, never the agent's work.

  **Its PROGRESS is joined live from the status channel**, by `taskId`. A
  sub-agent produces exactly two markers — start and terminal — so a
  marker-only row cannot change for its whole life: an eight-agent fan-out
  rendered as eight identical "running" lines for the eight minutes it ran,
  while the step for every one of those agents was already being parsed and
  dropped. `findLiveSubagent` (`chat/subagentStatus.ts`) is that join, and
  `SubagentRow` renders the step on its own line plus the cost climbing in the
  header. The overlay only ever ADDS to a LIVE row: it never moves a status (a
  `launched` agent stays launched) and it is skipped once the row is terminal,
  so the provider clearing the key at the end of an episode leaves settled rows
  exactly as their markers left them. Guarded by `items/activityGroupRows.test.tsx`.

  **Background agents used to die, and old sessions still show it.** `Agent`
  backgrounds the sub-agent unless the caller passes `run_in_background:
false`, and its tool result promises "you will be notified automatically when
  it completes". Until provider 0.4.14 that promise was false here: the
  provider killed `claude -p` at the turn's first `result`, which for a
  background call lands while the agents are still working. Measured
  2026-08-27: one lane launched five, two more nested inside them, and all
  seven were killed at the same millisecond having run 352 shell calls and
  spent 28.6M cache-read tokens that nothing ever read. 0.4.14 treats that
  `result` as a cycle boundary and lets the CLI re-invoke the model when the
  agents report, so their findings land in the same turn.

  Phosphor pins no provider version, so both shapes keep arriving. Nothing in
  the renderer checks a version: `trailingUnfinishedAgents` counts agents that
  never reached a terminal state, and only those raise the "never reported
  back" strip. `PI_CLAUDE_CLI_SETTINGS` → `--settings` with
  `permissions.deny: ["Agent","Task"]` remains the hard block, and it removes
  the tool from the model's list entirely.

  **Live progress rides the status channel, not the transcript.**
  `task_progress` fires once per sub-agent tool call (~700 times in the
  incident that motivated the channel), so the provider publishes a snapshot
  on `claude-subagents` instead. `chat/subagentStatus.ts` parses it into the
  strip's agent chip (one line, the newest running agent) and — via
  `findLiveSubagent` — into each transcript row's own step. That key MUST stay
  in `STRUCTURED_STATUS_KEYS` — while
  it was missing, `StatusStrip` printed the whole JSON payload along the
  bottom of the window. The provider clears the key when the episode ends
  (0.4.14), so a finished turn leaves the chip empty rather than pinning dead
  agents as "running".

  Sub-agent **spend** is no longer invisible, though their transcripts still
  are: from provider 0.4.10 the episode's billing comes from
  `result.modelUsage` (every model, sub-agents included) rather than
  `result.usage` (the main agent alone). Before that, a seven-agent turn
  reported \$2.34 of a real \$24.

**If you extend this** (tool request/response UX, live sub-agent trees): the
provider drops the `tool_result` blocks the CLI feeds itself between cycles,
so external tools have no result to show. That seam is named in that repo's
`docs/ARCHITECTURE.md` and surfacing it needs a provider change first, then a
step kind here. Do not attempt to infer it from the marker stream — the
argument preview is truncated and read best-effort precisely because nothing
may depend on it parsing.

**The sub-agent's own work is NOT one of those seams — it is on disk.** The
stream drops everything tagged `parent_tool_use_id`, but the CLI separately
writes each sub-agent a complete, live-appended transcript at
`~/.claude/projects/<mangled-cwd>/<session-id>/subagents/agent-<taskId>.jsonl`,
with an `agent-<taskId>.meta.json` sidecar carrying `agentType`,
`toolUseId`, `spawnDepth` and — for a nested agent — `parentAgentId`. So the
tree the provider says it cannot build IS reconstructable; just not from the
channel it reads. `taskId` is the join, and `pi-paths.ts` already exposes
`claudeProjectDirForCwd()`. Two traps if you build this:

- **Do not resolve the directory from the session's current
  `claudeSessionId`.** That id rotates on resume, and the `subagents/` folder
  keeps the id that was current when the agents SPAWNED — a project directory
  can hold `<idA>.jsonl` beside an `<idB>/` whose own `.jsonl` is long gone.
  Glob `<projectDir>/*/subagents/agent-<taskId>.jsonl` instead; task ids are
  unique.
- **`outputFile` only arrives at the terminal event**, so it cannot back a
  live view. (It is a symlink into the durable path above; the `/tmp` side of
  it gets reaped, the `~/.claude` side does not.) The provider publishes it on
  the status snapshot, and `parseSubagentStatus` does not read it yet — adding
  the field is the first line of that work.

## Sharp edges

- **The e2e stub is also a package manager.** `e2e/fixtures/pi-stub.cjs`
  dispatches on argv _before_ any RPC/session setup: `install`/`remove` edit
  the sandboxed settings.json and mirror the npm dir layout, `-p` answers
  print mode. An install must never create a stub session.
- **Two gated env hooks**, both `!app.isPackaged` for the same reason as
  `PHOSPHOR_PI_STUB` (an env var must not become code execution in a shipped
  app): the stub override for package jobs, and `PHOSPHOR_CLAUDE_BIN` for the
  Claude health probes. The latter exists because a developer's real
  `claude` shadowed a PATH-prepended fake and made the test machine-dependent.
- **`claude auth status` is local-only** (verified on 2.1.237), so the
  provider tab may probe it on mount; the `Test provider` run is not free —
  it spends a little plan quota, so it stays behind a button.
- Settings edits apply to **new sessions** (pi reads config at spawn). Every
  mutating surface says so.

## The Claude Code provider

`@saccolabs/pi-claude-cli` (our fork of `rchern/pi-claude-cli`) makes Claude
Pro/Max subscription models available inside pi's own agent loop by running
`claude -p` as a model server per turn. Phosphor treats it as an ordinary
package — the abstraction holds, and `shared/rpc.ts` needed no changes.

Its internals, and the compatibility fixes we shipped, are documented in
that repo's `docs/ARCHITECTURE.md`. Landing log:
[log/2026-08-21-claude-cli-provider-fixes.md](log/2026-08-21-claude-cli-provider-fixes.md).

### Two versions go stale, and only one of them is pi's

Settings → Extensions → **Claude Code** now checks both, because they drift
apart and each looks fine from the other's row:

- **`@saccolabs/pi-claude-cli`** — a pi package, so `packages:checkUpdates`
  already covered it. Updates through `pi update`.
- **The `claude` CLI itself** — not a pi package, so nothing covered it. The
  tab reads `claude --version`, asks the npm registry for
  `@anthropic-ai/claude-code`'s `latest`, and offers **Update** when the
  installed one is older (`packages:claudeCliLatest` /
  `packages:updateClaudeCli` in `electron/pi/packages.ts`).

The update runs `claude update`, **not** `npm install -g`. A 2.x install done
by the official script is a native build under
`~/.local/share/claude/versions/<version>` with a symlink in `~/.local/bin`;
npm does not own it, and `npm install -g` would leave that symlink pointing at
the old build. `claude update` handles both layouts. Both install kinds publish
the same version numbers, so one registry lookup answers for either.

### Updating the CLI does not add new models

The model list under the `pi-claude-cli` provider does **not** come from the
CLI. `index.ts` in that package builds it from
`getBuiltinModels("anthropic")` — pi's own bundled catalogue, a static JSON
file inside `@earendil-works/pi-ai`. A model Anthropic shipped yesterday
appears in the picker when **pi** updates, not when Claude Code does.

There is no user-side override for this. In pi's `provider-composer.js`,
`applyExtension()` runs after `applyModelsJson()`, and an extension that
registers a `models` array — which this one does — **replaces** the list
outright. A `models.json` entry for `pi-claude-cli` is discarded, and
`modelOverrides` ignores unknown ids, so it cannot add one either. The fix
belongs in the provider package. Confirmed 2026-09-01: pi-ai 0.84.4, the
latest published, still had no `claude-fable-5-1`.
