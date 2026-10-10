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
- Renderer sends scope enums and spec strings; every path is resolved in the
  main process (`libs/session-runtime/src/pi/packages.ts`).
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

**Curated catalogue** (`apps/desktop/src/features/settings/catalogue.ts`): five specs we
have read the source of: the Claude Code provider, the MCP adapter, web access,
subagents, computer use. An entry may declare `requiresBinary: 'claude'`,
which greys the card and says why when the binary is missing.

**Per-extension tabs.** Curated extensions get real config UIs, registered in
`EXTENSION_TABS` (`settingsIndex.ts`) and shown **only while their package is
present**. They render nested under the Extensions entry, since they configure
an installed package; a stale sub-tab falls back to the Extensions list.

| Tab          | Package                      | Contents                                                                                                                       |
| ------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code  | `@saccolabs/pi-claude-cli`   | health card (package / `claude` binary / account), tested-version warning, **Test provider** one-click proof, failure playbook |
| Web access   | `pi-web-access`              | seven common search-provider keys (password fields, `$ENV_VAR` support), raw JSON editor                                       |
| Subagents    | `pi-subagents`               | delegation guide, profile precedence, configuration sources, raw Pi settings and lane directives                               |
| Computer use | `@injaneity/pi-computer-use` | what the tools do and the OS accessibility permissions macOS will not grant silently                                           |

**MCP Connectors renders in the same slot but is NOT in `EXTENSION_TABS`**: it
shows unconditionally, because its Advanced disclosure is where
`pi-mcp-adapter` gets installed. Gating it on the adapter would hide the only
surface that can produce the adapter. See [mcp.md](mcp.md).

The Subagents tab explains optional configuration without creating a second
runner or profile registry. It appears only for an installed package in the
active workspace's package list. See [settings.md](settings.md#subagents-pi-subagents).

**First run.** `PiMissingScreen` offers one-click Install/Update pi with
streamed output and an auto re-check. A successful install lands on
`GettingStartedScreen`: provider guidance plus the same catalogue cards.

## Command approval dialogs

A permission gate is an extension that hooks `tool_call`, decides a `bash`
command is dangerous and asks through `ctx.ui.select` / `ctx.ui.confirm`. What
arrives is an ordinary `extension_ui_request` whose title is **prose the
extension wrote, with the whole command inside it**. Rendered generically, a
60-line heredoc becomes a dialog _title_.

`libs/shared/src/command-approval.ts` claims those dialogs and
`apps/desktop/src/features/extension-ui/CommandApprovalSheet.tsx` renders them
as a review surface. Two pure steps:

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

`apps/desktop/src/dev/mockPhosphor.ts` raises one in the browser harness when a prompt
starts with `danger`.

### Optional permission gate and scratch cleanup

`libs/pi-extensions/pi-ext/optional/permission-gate.ts` is an opt-in, standalone global gate,
not one of Phosphor's six loaded extensions. To install it, review the file,
back up any existing `~/.pi/agent/extensions/permission-gate.ts`, then copy it
there. Use `/reload` in pi or start a new Phosphor session to load the change.

The gate judges what the shell would run, not the text of the script. It
carries a small lexer for bash quoting, heredocs and substitutions, so text in
a heredoc written to a file, a quoted argument, a comment or `os.kill` inside
Python never prompts. `$(…)`, backticks, `bash -c`, `eval`, `trap`, `ssh`,
`find -exec`, `xargs` and heredocs or herestrings fed to a shell are judged
like any other command. A script it cannot follow falls back to the old
whole-text patterns, so a parser gap costs a prompt, never a pass.

It asks for `sudo`/`su`/`doas`, `shred`, `truncate`, `git push --force`
(`-f`, `+ref`), `git reset --hard`, `systemctl`/`service` changes, and:

- In a linked git worktree (a lane), `rm -r` runs unasked only when **every
  target resolves to a descendant of that worktree**. Relative and absolute
  literal paths work, including missing descendants; existing ancestors are
  resolved to catch symlink escapes. The lane root, home, parents, other
  checkouts, globs and variable targets like `"$t"` still ask. A shell cwd change
  makes relative targets unknown, except an absolute `cd` to the original cwd.
  Scripts containing `ln`/`mv` (including child shells), `eval`/`source`, remote
  commands, traps and `find -exec` get no lane exemption. Other findings in the
  same script still ask, even alongside a lane-local delete.
- A lane may also delete, unasked, a literal absolute or `~/` path to a
  pi-scratch job (`~/.pi/agent/scratch/job-<32 hex>`, the names the helper
  below creates) or anything inside one. The scratch root, other names in it,
  a symlinked root, symlinks out of the job and variable targets still ask.
- Outside a linked worktree, the existing `rm -r` exemptions remain: literal
  paths under `/tmp`, `/private/tmp`, `/var/folders` or `~/.pi/agent/scratch`,
  and relative build-output directories such as `node_modules`, `dist` or
  `test-results`. `/tmp/*`, `..` and variable targets still ask.
- `kill` only for `-1`, `0` or a negative pid (every process, or a group).
- `pkill` unless it is `pkill -f` with a specific pattern (a path, file name,
  flag or port). `killall` always asks.
- `chmod`/`chown 777` unless every target is a literal temp path.

`git push --force-with-lease` passes. Nothing is refused outright: every
finding is a question, and the heading names it (`Dangerous command (rm -r):`).
AWS alone does not prompt, including writes and non-local endpoints:
authorization is left to the machine's AWS credentials and IAM policies. Other
checks still examine the whole script, including commands alongside AWS calls.
Install this policy only where that AWS access is intentional.

For prompt-free cleanup, copy `libs/pi-extensions/pi-ext/optional/pi-scratch.py` to
`~/.pi/agent/bin/pi-scratch.py`. It requires POSIX and Python 3.11+ with
symlink-resistant `shutil.rmtree`. It creates private, randomly named jobs in
`~/.pi/agent/scratch`, and only deletes a named job inside that root:

```bash
t=$(python3 ~/.pi/agent/bin/pi-scratch.py create)
# Put disposable work in "$t".
python3 ~/.pi/agent/bin/pi-scratch.py clean "$t"
```

The helper validates the resolved argument at execution time, rejects root/job
symlinks, traversal and shared roots, and does not follow links inside a job.
It never cleans arbitrary `/tmp` directories. Recursive deletion outside the
lane and the applicable exemptions still prompts; mentioning the helper or
`mktemp` does not exempt another command.

**Settings → Agent → Directives → Your own text** can teach new sessions:
"Create temporary work with `python3 ~/.pi/agent/bin/pi-scratch.py create`;
clean only the returned directory with `python3 ~/.pi/agent/bin/pi-scratch.py
clean <directory>`. Prefer this helper over recursive shell deletion."
Global directives can be overridden by project directives. The gate's rules
are edited in its installed TypeScript file, not in the Directives field.

These are accident guards, not a sandbox or a policy for SDK calls, other
tools, aliases, or substituted executables. Path checks happen before execution,
not atomically with deletion; arbitrary programs and concurrent filesystem
changes can defeat them. Phosphor only renders approval
requests. The optional gate and helper are not installed by app updates.

## Foreign config files

Some packages keep config outside pi's settings. Phosphor mirrors each
package's own resolution rather than guessing:

- `pi-web-access` → `web-search.json` from `PI_CODING_AGENT_DIR`, then
  `XDG_CONFIG_HOME/pi`, then **`~/.pi`** (not `~/.pi/agent`). Mirrored by
  `webSearchConfigPath()` in `pi-paths.ts`.
- Structured writes merge-patch and **refuse to write over a malformed file**;
  the tab disables its fields and points at the raw editor.

## Code map

- Main: `libs/session-runtime/src/pi/packages.ts` and `package-resources.ts`
  (spec classification, install-dir resolution, resource discovery);
  `apps/desktop/electron/pi/packages.ts` (job runner, `claudeStatus`).
- IPC: `packages:list / run / installPi / checkUpdates / detect /
claudeStatus / claudeCliLatest / updateClaudeCli / testClaudeProvider`
  (`apps/desktop/electron/ipc/packages-handlers.ts`); `pi:webSearchConfig /
patchWebSearchConfig` (`pi-config-handlers.ts`).
- UI: `tabs/ExtensionsTab.tsx`, `tabs/ClaudeProviderTab.tsx`,
  `tabs/WebAccessTab.tsx`, `tabs/ComputerUseTab.tsx`, `CatalogueCards.tsx`,
  `catalogue.ts`, `usePackageJob.ts`, `JobOutput.tsx`, `app/PiMissingScreen.tsx`,
  `app/GettingStartedScreen.tsx`. Mock cases in `apps/desktop/src/dev/mockPhosphor.ts`.

## Bundled extensions (Phosphor's own)

Separate from packages the user installs, Phosphor ships **six** TypeScript
extensions in `libs/pi-extensions/pi-ext/`, loaded into **every** session via
`pi --mode rpc -e <path>` (`bundledExtensions()` in
`libs/session-runtime/src/bundled-extensions.ts`, called by `apps/desktop/electron/pi/session-runtime.ts`). They are the only Phosphor code with a
say inside a turn.

The private `@phosphor/pi-extensions` source package keeps these standalone
files and adjacent tests together. Development resolves the resource root at
`libs/pi-extensions`; packaged apps still read `resources/pi-ext`, outside the
asar. The builder copies the same non-test TypeScript inventory, including
`context-budget.ts` imported by `context-breakdown.ts`, `artifact-store.ts`
imported by `artifacts.ts`, and the optional gate.
Optional Python helpers remain in the source tree, not the shipped resource filter.

| File                   | Why it must run inside pi                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `artifacts.ts`         | registers the artifact tools (see below)                                                     |
| `context-breakdown.ts` | measures context composition — the parts are only visible in-process                         |
| `worktree-paths.ts`    | refuses a file read that has escaped a worktree into the main checkout                       |
| `tool-name-guard.ts`   | rewrites a malformed tool call before pi persists it and bricks the thread                   |
| `mcp-status.ts`        | forwards the MCP adapter's per-server status off pi's shared event bus                       |
| `headroom.ts`          | compresses large tool results through a local Headroom proxy at the moment they are produced |

### The artifact tools, and what each one costs

`artifacts.ts` registers six tools. The split exists because an artifact's
token cost is **entirely the arguments the model writes**: the payload riding
in `details` never reaches the model and is free. What is not free is
resending a document to change part of it.

| Tool              | Cost                          | Use                                       |
| ----------------- | ----------------------------- | ----------------------------------------- |
| `artifact_help`   | authoring guide, on demand    | load before creating or restyling         |
| `artifact_create` | the whole document            | new artifact                              |
| `artifact_edit`   | just the changed region       | **the default way to revise**             |
| `artifact_update` | the whole document, again     | rewrites that touch most of the content   |
| `artifact_read`   | the document, or a line range | recovering text after compaction, to edit |
| `artifact_list`   | ids and sizes only            | recovering ids after compaction           |

The short authoring guide lives in `artifact_help` results, not in the
always-loaded schema or system guidelines. Documents default to Markdown;
HTML is for layout or interaction that needs it. Use paragraphs, lists and
code blocks, tables only for repeated-field comparisons, and diagrams only
when clearer than text. No mandatory chart/table pairs or decorative cards.
Markdown supports Mermaid and chart fences without hand-positioned SVG.
The tool description keeps the HTML-fragment and no-network constraints.

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
an edit has to apply to the live text in a resumed session. `session_tree`
and `session_compact` rebuild it too, so tree navigation lands on that
branch's versions.

### The artifact store

Artifacts outlive their session's context. Compaction drops old tool results
from what `get_messages` returns, and a provider switch restarts pi, so a pane
rebuilt only from `get_messages` used to come back empty. The session file
still holds every version; the store indexes it.

- **Layout.** `<userData>/artifacts/blobs/<sha256>` holds each distinct
  content once. `sessions/<sessionId>.json` holds one session's artifacts,
  every version on every branch with an `onBranch` flag, plus the scan
  position. The format and read side live in `libs/pi-extensions/pi-ext/artifact-store.ts`;
  ids and slugs are regex-checked before they reach a path.
- **Main is the only writer** (`apps/desktop/electron/artifacts/`:
  `artifact-indexer.ts` reads one file, `artifact-library.ts` owns the store,
  `artifact-sync.ts` wires it up). It indexes a session file incrementally
  (resuming at the last byte read, rescanning when the file was rewritten or
  the branch moved under old versions) on `agent_end`, `compaction_end` and pi
  exit, when a pane asks, right before a delete, and in a one-file-at-a-time
  backfill of `~/.pi/agent/sessions` 20s after launch. It reads only results
  pi wrote, so native and Claude sessions, forks, routines and sessions run
  outside Phosphor all index the same way.
- **The session file stays the source of truth.** The store is a rebuildable
  cache, with one exception: a session whose file is gone, however it went
  (deleted in Phosphor, in Finder, by pi), keeps its artifacts, marked
  deleted, until they are removed from the Artifacts page. A gone session with
  no artifacts leaves nothing behind.
- **pi reads it.** Phosphor passes `PHOSPHOR_ARTIFACT_STORE` at spawn. Without
  it (plain pi), this session's artifacts work as before and the cross-session
  features say they are unavailable.

What the model can do with it, all optional parameters on the same tools:

| Call                                              | Does                                                |
| ------------------------------------------------- | --------------------------------------------------- |
| `artifact_list({ scope: "all", query })`          | lists other sessions' artifacts as refs             |
| `artifact_read({ id: "<session>/<slug>[@vN]" })`  | reads another session's artifact, read-only         |
| `artifact_read({ id, version, offset, limit })`   | reads an older version, or a 1-based line range     |
| `artifact_create({ title, from: "<ref or id>" })` | copies an artifact into this session, to edit there |

A ref's session may be a unique prefix of 8+ characters. A foreign read
records `details: { ref, foreign: true }` with no `id` or `content`, so no
`session_start` rebuild, current or older, adopts it as this session's own.
Sessions never edit each other's artifacts; `from` makes a local copy. A ref
to the session itself is just a local id, and its `@vN` copies an older
version.

**After compaction the model gets a short index.** The `context` hook inserts
a hidden `custom` message (`phosphor-artifact-index`) right after the
compaction summary, listing the artifacts written before the latest
compaction (id, version, type, title; at most 40). It is request-local, never
persisted, and stable between requests so the prompt cache holds. It costs
about 20 tokens per artifact and points the model at `artifact_read` for the
content and `artifact_list` for current versions.

**Artifacts execute JavaScript, on their own origin.** They are NOT rendered
with `srcdoc`: a srcdoc document inherits the app's policy container, so the
app CSP refuses every inline script and the sandbox attribute becomes a no-op.
`apps/desktop/electron/artifacts/artifact-protocol.ts` serves staged HTML over
`phosphor-artifact://` with its own `default-src 'none'` policy, and the iframe
keeps `sandbox="allow-scripts"` **without** `allow-same-origin`, which keeps
the origin opaque. Measured, not assumed: scripts run; storage, cookies,
parent and sibling DOM, top navigation, `fetch`, `sendBeacon`, WebSocket,
remote images and form POSTs are all refused. Never add `allow-same-origin`,
and never add a `connect-src`. Either one hands model-authored HTML a channel
out.

**Documents use a single readable column, not a dashboard template.**
Markdown previews use the app's typography within a bounded reading width.
`apps/desktop/electron/artifacts/artifact-skeleton.ts` styles semantic HTML
(headings, lists, code, quotations, definition lists, details and tables)
without custom classes. It wraps fragments and injects CSS before any
model-authored styles. The theme follows Phosphor, with app-matched neutrals
and accent. Code and genuinely wide tables scroll locally.

Existing `--art-*` tokens, series colors and opt-in layout classes remain
supported, but are no longer part of the authoring guide. Existing artifacts
are restyled when staged, not rewritten. The model's own styles can override
the defaults. Network access remains blocked; Markdown's built-in diagram
renderers do not imply that libraries are available inside HTML artifacts.

**The PDF export prints the staged document, not a second one.**
`apps/desktop/electron/artifacts/artifact-pdf.ts` calls the same `stageArtifactHtml`, loads
the `phosphor-artifact://` URL in a hidden sandboxed window and `printToPDF`s
it, so the sheet, the theme stamp and the CSP are the preview's. The version it
replaces built its own document: a hand-copied subset of the sheet that knew
nothing of `.kpis`, `table.data` or `.ledger`, `marked` and `mermaid` from a CDN
(the CSP refuses exactly that), a hardcoded dark theme, and a page measured
1200px wide but printed 816px wide, which pushed the tail of a long artifact off
the bottom. Two document builders is one too many. The types the renderer draws
— markdown, mermaid, chart, code — have no main-process renderer at all, so the
pane serialises its rendered preview instead
(`apps/desktop/src/features/artifacts/previewHtml.ts`: canvases become `data:` images,
buttons are dropped) and hands that over as the markup to stage.

**It prints US Letter pages, and places the breaks rather than avoiding them.**
The staged document gets one extra `<style>`, `ARTIFACT_PRINT_STYLE`, appended
after the body — last in the document, so unlike the house sheet the model
cannot override it, and scoped to `@media print`, so it cannot reach the
preview. It keeps a `.kpis` strip, a `.panelbox`, a `.callout`, a `.verdict`, a
`pre`, an `svg` and a table row whole across a break, repeats a long table's
`thead` on each page it spans, keeps a heading attached to what it titles, and
unwraps anything that scrolled on screen, because a clipped `.scroll` prints as
missing content. Page size and margins are set once, in `artifact-pdf.ts`, and
never from a model's `@page` rule.

Before this, the export measured the document and made the page that tall — one
page, 8.5 x 39 inches on a real walkthrough. It dodged pagination instead of
solving it, and it did not even work: measuring happens in a window, printing
happens in Chromium's print layout, and a few pixels of disagreement put the
last two lines on a second 39-inch page that was 97% empty. There was 0.5in of
slack and the drift exceeded it.

**A printed margin is never painted with the artifact's ground.** Measured on
Electron 43 with the background on `body` and on `html`, with `color-scheme`
dark and absent: all four leave the margin at the UA canvas (#121212 under a
dark scheme, bare paper without one) while the content box keeps `--art-bg`. So
a dark artifact prints with a faint frame. That is the cost of having margins at
all, and it is worth paying — physical printers cannot reach the sheet edge, so
a full-bleed page loses its outermost content on paper.

Every tool an extension registers should declare at least one **required**
parameter. A call with no arguments reaches pi as `arguments: ""` on the
Claude Code provider, and pi validates before `execute`, so an all-optional
schema fails every call with `root: must be object`.

`worktree-paths.ts` is the only bundled extension that can refuse a tool call. A
worktree session's cwd contains the main checkout as a prefix, and models
rebuild absolute paths from what they think the project root is, so a session
in `.phosphor/worktrees/<name>` was reading files off a different branch.
`tool_call` is the one hook that sees the path before the file is opened. The
rule is deliberately four-condition narrow (worktree session, path outside
cwd, path inside the main checkout, counterpart exists in cwd) because pi's own
system prompt sends the model to absolute paths outside the cwd for its docs.

`context-breakdown.ts` also installs the session-local window cap from
`context-budget.ts`. Its host-only command stages budget changes; model metadata
is cloned at idle or safe turn boundaries so pi performs native compaction
without aborting a run. See [One context budget](cli-providers.md#one-context-budget).

`context-breakdown.ts` exists because pi reports context usage as one number,
and the composed system prompt and active tool schemas are not reachable from
the renderer. Three traps: `getAllTools()` returns definitions (the schemas that
occupy context) while `getActiveTools()` returns **names**; it publishes at
rest (`session_start`, `model_select`, `agent_settled`, `turn_end`), never mid-stream; and
messages are measured over `sessionManager.buildContextEntries()` with pi's
own per-role `estimateTokens` rules, never over `getBranch()`, which still
holds every compacted-away message (measured: 292k for a 151k context). That
list is the only cut on every provider: from pi-claude-cli 0.9.0 the Claude
Code provider replays it whole, so an old `[Claude Code · compact {…}]` marker
is text in its message, not a cut point. It attributes MCP schema cost **per
server** using the adapter's server names and `toolCount` from pi's shared
event bus (`pi-mcp-adapter/status/v1`), and reports per server how many
schemas are in the window and how many of those are the server's own tools
rather than the gateway proxy.

`mcp-status.ts` exists for the same reason in the other direction: the adapter
publishes each server's state on that bus, but pi's RPC has no channel for it.
It forwards the snapshot verbatim.

### The status channel is a wire contract

Bundled extensions and provider packages talk to Phosphor's UI the same way:
`ctx.ui.setStatus(key, text)` → pi's extension-UI request → the per-session map
in `stores/extensionUi.ts`. Five keys are load-bearing, and the key strings are
**case-sensitive literals on both sides**; nothing fails to compile when they
disagree.

| Key                          | Emitter                                          | Consumer                                                                                                                   |
| ---------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `phosphor-context-breakdown` | `libs/pi-extensions/pi-ext/context-breakdown.ts` | `chat/composer/contextBreakdown.ts` → ContextMeter                                                                         |
| `phosphor-mcp-status`        | `libs/pi-extensions/pi-ext/mcp-status.ts`        | `connectors/mcpStatus.ts` → Connectors, footer                                                                             |
| `phosphor-headroom`          | `libs/pi-extensions/pi-ext/headroom.ts`          | `chat/composer/headroomStatus.ts` → ContextMeter (Optimization section)                                                    |
| `claude-rate-limit`          | `@saccolabs/pi-claude-cli` ≥ 0.4.5               | `chat/composer/rateLimit.ts` → ContextMeter, RateLimitBanner; `libs/shared/src/claude-limits.ts` → account routing in main |
| `claude-subagents`           | `@saccolabs/pi-claude-cli` ≥ 0.4.13              | `chat/subagentStatus.ts` → the status strip's agent chip, for sessions recorded before 0.9.0 (see below)                   |

The two `claude-*` keys cross a repo boundary; their shape is documented on the
emitting side in that repo's `docs/ARCHITECTURE.md`. Rules for all five: the
payload is JSON in a string, every parser returns `null` rather than throwing,
and a missing key means "render nothing", never an empty section. A structured
key must also be listed in `STRUCTURED_STATUS_KEYS`
(`features/extension-ui/ExtensionUiHosts.tsx`) or the status strip prints its
JSON as prose. Status pushes must never be able to break a turn, so emitters
swallow their own errors.

**Widgets are the same bus with the same rule.** `setWidget` carries lines for
the composer slot, and a key carrying a machine payload must be in
`STRUCTURED_WIDGET_KEYS` (same file) or the slot prints it. Two are
load-bearing today, both from `pi-subagents` in RPC mode:

| Key                | Payload                                                                        | Consumer                                                     |
| ------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `subagent-async`   | One line, `PI_SUBAGENT_ASYNC_JSON:` + a versioned snapshot of background runs  | `chat/subagentRuns.ts` `parseFleetWidget` → the agent chip   |
| `subagent-inspect` | `PI_SUBAGENT_INSPECT_JSON:` replies to `/subagents-inspect-rpc`, by request id | Read-only Subagents inspector; raw widget lines never render |

The extension's component widgets (its FleetView) never reach Phosphor: pi's
RPC mode forwards only string-array widgets and drops factories.

## How provider transcripts render

Current Claude sessions use pi tools and pi compaction. Older provider sessions
contain block shapes pi itself never emits, so the transcript layer retains
provider-specific handling
(`items/transcriptRows.ts`; contract table in
[chat.md](chat.md#blocks-from-the-claude-code-provider)).

- **The CLI compacting its own session** was recorded as a
  `[Claude Code · compact {"trigger","preTokens","postTokens","durationMs"}]`
  marker (provider 0.8.3–0.8.x), no `#id` tag because nothing pairs with it.
  `compactDivider` in `items/transcriptRows.ts` turns it into the same
  compaction divider pi's `compaction_end` draws — its own row, never an
  activity step — with `trigger: "manual"` read as a manual compaction and
  anything else as threshold. A payload that does not parse still draws the
  divider, without figures. Every key is optional and absent means "not
  reported", never zero. The divider records that old cut only: from 0.9.0 the
  provider replays pi's whole context, so the model holds both sides of it
  again.

- **CLI-side tools, in sessions recorded before 0.9.0** (WebSearch,
  WebFetch, ToolSearch, the user's own MCP servers, sub-agents) ran _inside_
  the CLI, so pi never saw them as tool calls. The provider reported each as a
  `[Claude Code · Name {args}]` marker; Phosphor parses it into an
  `externalTool` activity step. A current session runs every tool in pi, so
  its rows are ordinary pi tool rows.

  **They render in pi's vocabulary.** `summarizeExternalTool` maps the marker's
  tool name onto the same verbs pi's own tools get (`Bash` → `Ran`, `Grep` →
  `Searched for`), with the same monospace treatment and the same
  operative-line labelling. An old Claude-provider turn interleaves these rows
  with pi's, and two vocabularies made one turn read as two transcripts.
  Provenance survives as a small `cc` mark in the row gutter (absolute, reserving no
  column, sharing a slot with the ✳ reasoning mark) plus the full marker in
  the row's `title`. An unrecognised tool keeps its NAME as the emphasis;
  `mcp__linear__save_issue` says more than any verb we could invent.

  **What the row may claim is bounded by what the markers carry.** With
  `PI_CLAUDE_CLI_TOOL_RESULTS=1` in legacy sessions, the provider tags each
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

- **Sub-agents, in sessions recorded before 0.9.0**: `Agent`/`Task` markers
  render as sub-agent rows (badge, description, status, cost, expandable
  prompt). A current session delegates through `pi-subagents` inside pi on
  both providers and renders from the `subagent` tool call instead
  ([chat.md](chat.md#sub-agents)); nothing below applies to it.

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
  Both shapes are on disk: `trailingUnfinishedAgents` counts agents that
  never reached a terminal state, and only those raise the "never reported
  back" strip.

  **Live progress rode the status channel, not the transcript.**
  `task_progress` fired once per sub-agent tool call, so the provider
  published a snapshot on `claude-subagents` instead, parsed into the strip's
  chip and each row's step, and cleared it when the episode ended. That key
  MUST stay in `STRUCTURED_STATUS_KEYS` while the parser remains.

  Sub-agent **spend** is visible from provider 0.4.10, which bills from
  `result.modelUsage` (every model, sub-agents included) rather than
  `result.usage` (the main agent alone).

**If you extend tool UX or sub-agent views**, build on pi's tool calls and
pi-subagents' events: every tool, delegation included, is now a pi tool call
on both providers. The marker stream is frozen: nothing new should be added
to it or inferred from it.

**A pre-0.9.0 sub-agent's own work is on disk.** The CLI wrote each sub-agent a
complete, live-appended transcript at
`~/.claude/projects/<mangled-cwd>/<session-id>/subagents/agent-<taskId>.jsonl`,
with an `agent-<taskId>.meta.json` sidecar (`agentType`, `toolUseId`,
`spawnDepth`, `parentAgentId` for nested agents). `taskId` is the join;
`pi-paths.ts` exposes `claudeProjectDirForCwd()`. Two traps: do not resolve
the directory from the session's current `claudeSessionId` (it rotates on
resume; glob `<projectDir>/*/subagents/agent-<taskId>.jsonl` instead), and
`outputFile` only arrives at the terminal event, so it cannot back a live view.

## Sharp edges

- **The e2e stub is also a package manager.** `apps/desktop/e2e/fixtures/pi-stub.cjs`
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
`libs/shared/src/rpc.ts` needed no changes. Its internals are documented in that repo's
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
