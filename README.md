<picture>
  <source media="(prefers-color-scheme: dark)" srcset="apps/desktop/build/icon.svg">
  <source media="(prefers-color-scheme: light)" srcset="apps/desktop/build/icon-light.svg">
  <img src="apps/desktop/build/icon.svg" alt="Phosphor" width="88" height="88">
</picture>

# Phosphor

**One mission. Many agents. Your IDE.** Phosphor is the open-source multi-agent
IDE built on the [pi coding agent](https://pi.dev), for macOS and Linux (Windows builds are paused and will return).
Run independent tasks in isolated lanes, delegate focused pieces inside a lane,
and stay close to every decision, diff and result. Pi stays the small, extensible
harness underneath: tools, model providers and skills install as pi packages.

[![Website](https://img.shields.io/badge/phosphor.saccolabs.com-eca03d?label=web&labelColor=1e1c18)](https://phosphor.saccolabs.com)
[![CI](https://github.com/agustinsacco/Phosphor/actions/workflows/ci.yml/badge.svg)](https://github.com/agustinsacco/Phosphor/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/agustinsacco/Phosphor?label=release&color=ffbe5c)](https://github.com/agustinsacco/Phosphor/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/agustinsacco/Phosphor/total?label=downloads)](https://github.com/agustinsacco/Phosphor/releases)
![License: MIT](https://img.shields.io/badge/license-MIT-8ec9a0)

Give every task its own agent and Git worktree, and watch each command, edit
and diff as it happens. The chat renders what models actually produce (diffs,
diagrams, charts, sandboxed HTML), the file explorer and terminal sit next to
it, and every change the agent made is there to review or revert.

Use the plans you already pay for: ChatGPT Plus/Pro, Claude Pro/Max through
[pi-claude-cli](https://github.com/agustinsacco/pi-claude-cli), GitHub Copilot
or Kimi. Or bring an API key for any provider pi speaks: Anthropic, OpenAI,
Google Gemini and Vertex, Azure OpenAI, Amazon Bedrock, Mistral, Groq,
Cerebras, xAI, OpenRouter, and the Cloudflare and Vercel gateways. Switch
models mid-session and the conversation comes along.

|                                        |                                                        |
| -------------------------------------- | ------------------------------------------------------ |
| **One lane per task**                  | Its own agent, worktree and diff                       |
| **Every change is reviewable**         | Tool calls with their output, diffs, per-file revert   |
| **Every session is a real pi process** | Your pi setup, extensions and session files carry over |
| **Runs on your machine**               | MIT licensed, no sign-up, your models and keys         |

![Curated Remote Hosts replay: four workstreams and a scoped parent decision in the Subagents pane](apps/site/src/assets/shots/remote-hosts.webp)

_Recorded work, curated replay in the real UI. Excerpts shortened and task labels
expanded; private paths and unrelated projects omitted. Historical activity, not
a live run. [Case study and capture provenance](https://phosphor.saccolabs.com/guides/swarm/#case-study)._

## Quick start

```bash
# 1. pi is the agent. Phosphor needs it on your PATH (Node ≥ 22.19)
npm install -g @earendil-works/pi-coding-agent

# 2. Install Phosphor (macOS / Linux)
curl -fsSL https://github.com/agustinsacco/Phosphor/releases/latest/download/install.sh | sh
```

Launch Phosphor, open a folder, sign in to a provider (run `pi` in the built-in
terminal and use `/login`, or put API keys / a local endpoint in
`~/.pi/agent/`). Describe a task, press Enter. Alternatives are under
[Install](#install).

## What Phosphor does

- **Sessions are real pi subprocesses.** One `pi --mode rpc` per live session,
  spawned in the workspace folder. Everything pi exposes over RPC is in the UI:
  models, thinking levels, steering and follow-up queues, compaction,
  auto-retry, forks, clones, export.
- **No permission prompts by default.** pi runs in full-permission mode. Tool
  calls run and stream their results. Want confirmations? Install a
  permission-gate extension and Phosphor shows its questions as a review sheet
  ([optional gate](docs/extensions.md#optional-permission-gate-and-scratch-cleanup)).
- **Local routines.** Save instructions, choose a workspace/model and a preset or
  cron schedule, and get a fresh lane per run. Persistent history, catch-up,
  cancellation, and optional background operation. Runs only while the computer
  is awake, and agents keep full tool permissions. [Routines](docs/routines.md).
- **Rich responses are first-class.** GFM markdown, highlighted code, Mermaid,
  Chart.js and Vega-Lite specs, KaTeX, and model-authored HTML in a sandboxed
  iframe.
- **Every change is reviewable.** The Changes panel holds the agent's edits as
  per-file diffs against a session baseline, with per-file revert.
- **Session tree.** See the branch structure, jump to any point, fork from it,
  bookmark it.
- **Artifacts.** A bundled extension adds `artifact_create` / `artifact_edit` /
  `artifact_update`. Deliverables land in a versioned side panel with previews
  and diffs, and survive compaction, restarts and session deletion in an
  artifact store.
- **Your machine, your models.** Sign in to providers, pick models, set themes,
  mount MCP servers from Settings. MCP is built into pi, and its OAuth belongs
  to pi, never to Phosphor: [docs/mcp.md](docs/mcp.md).

## Multi-agent work, without losing the thread

**Parallel lanes** keep separate tasks on separate branches. **Subagents within a
lane** let a parent delegate bounded pieces through the optional pi-subagents
package, answer scope questions, and integrate the results. The current-work
summary and dockable Subagents pane keep foreground/background work inspectable.
Missing status means unavailable, not finished. Execution completion, independent
acceptance and successful integration are separate checkpoints.

The **Swarm** switch grants per-lane standing authorization for proactive
delegation when useful. It does not itself launch agents, assign models or widen
permissions. Off removes that authorization from future requests, not existing
children or history. Old lanes need a Pi reload/restart to acquire the command;
forks and clones start off. [Swarm behavior](docs/chat.md#swarm-authorization).

For example: **Astra** explores the architecture, **Opus 5.5** orchestrates and
integrates, and **Sol 6.1** implements scoped changes and performs separate
reviews. These are illustrative assignments, not automatic presets. Choose
available models and effort through pi and pi-subagents; Claude subscriptions can
connect through pi-claude-cli.

**Real work: Phosphor Remote Hosts.** The recorded parent used Astra and Opus 5.5
at different stages, with Sol 6.1 assigned to workers and reviewers. One phase
split enrollment API, Host lifecycle, Desktop live status and documentation into
four workstreams. Workers requested scope exceptions; independent reviews and
retained work made decisions and recovery inspectable. The lane predates the
Swarm switch and used explicitly authorized delegation. This is a development
case study, not a claim that remote execution has shipped.
[Work with a swarm](https://phosphor.saccolabs.com/guides/swarm/) ·
[Current remote-access boundary](docs/remote-access.md).

## The screens

Every session pairs the transcript with one switchable pane: Files, Changes,
Terminal, Artifacts or Subagents. The pane docks left or right (persisted per session) and
can go fullscreen. The feature shots below are the app against a real pi, real
providers and real tokens. The Remote Hosts image above is a labelled curated replay; see
[the screenshots in this README](#the-screenshots-in-this-readme).

### Home: where a session starts

Pick the folder, the branch (or a fresh worktree branch off trunk), the model,
and go. The sidebar lists every session with live state, edit counts, a
worktree badge and the PR badge once one exists.

Above the composer is the **workbench**: responsive tiles for this project's
lanes, with status, the latest observed tool, and a bounded background-run
preview. Tiles keep their positions while home is open, including when a task
becomes idle. First-turn lanes appear before pi saves their transcript. Open a
lane, answer its question, inspect subagents, or use the existing merge/update
flow. Below it, a **ledger** shows spend, tokens, live processes, and account
headroom.

The workbench derives from state the app already holds. It does not poll agent
activity or spend tokens. Opening the shared subagent inspector explicitly
requests details; unopened transcripts are not loaded for tile previews.

![Home over the real sessions of a repo](docs/img/home.png)

### Chat: the transcript, not a blob

Streaming text with the run's activity folded into steps: edits expand to their
diff, tool calls to their arguments and output, thinking to its own block. The
composer takes `@` file references, `/` commands, `!` shell lines, and queues
follow-ups while a turn is running.

![A finished turn: the activity run expanded on the edit's diff, Changes panel open beside it](docs/img/changes.png)

### The composer: every model, one chip away

The model chooser lists everything you are signed into, native providers and
installed provider packages alike. Searchable, starrable, switchable
mid-session. The chip names what actually serves the session (`pi-claude-cli`
when it is your Claude subscription):

![The model menu open over the composer](docs/img/models.png)

Models with a thinking ladder get a second chip for effort:

![The thinking-level menu](docs/img/thinking.png)

The context meter opens into a live breakdown of the window: what the system
prompt, tools and conversation cost, and your plan's rate-limit window on
subscription providers:

![The context meter popover](docs/img/context.png)

`/` opens commands, `@` mentions workspace files:

![The slash-command menu](docs/img/commands.png)

![The @ file-mention menu, resolved against the workspace](docs/img/mentions.png)

Turn on voice input in Settings → Voice and a microphone beside Attach
dictates into the draft. The speech model runs on your computer, so audio never
leaves it ([docs/voice.md](docs/voice.md)).

### Files: explorer and editor, on whichever side you like

Create, rename, Trash, multi-select, copy/cut/paste, drop files and folders
in, all beside a Monaco editor. Docked right by default.
[File management details](docs/files.md):

![The files pane on the right: explorer and Monaco editor beside the transcript](docs/img/files.png)

One click moves the pane to the left. The choice is per session and persists:

![The same files pane docked on the left of the chat](docs/img/files-left.png)

Any pane can take the whole session region when the transcript is not the thing
you are reading:

![The files pane fullscreened over the session](docs/img/files-full.png)

### Terminal: real shells in the workspace

Real terminal tabs against the workspace, owned by the session that opened
them, so the transcript never loses its place.

![A terminal tab open against the workspace, beside the transcript](docs/img/terminal.png)

### Artifacts

Long documents, HTML pages, SVG, Mermaid and chart documents the model creates
for you. Versioned, previewable, diffable, and kept in a store that outlives
compaction and the session itself.

![A long document open in the artifacts pane](docs/img/artifacts.png)

### Settings, and not only in dark

Appearance, writing, agent, accounts, extensions, connectors, workspaces,
optimization, voice, advanced, keybindings, about. Light theme included,
because diff review at 2am is a real workflow.

![The Appearance tab](docs/img/settings.png)

Accounts is where providers sign in, subscription or API key, per provider:

![The Accounts tab with signed-in providers](docs/img/accounts.png)

Connectors mounts MCP servers (Notion, Linear, anything with an MCP endpoint)
through pi's built-in MCP. OAuth is pi's, never Phosphor's:

![The Connectors tab](docs/img/connectors.png)

The light theme, on the edit session:

![The session in the light theme](docs/img/light.png)

## Install

macOS and Linux:

```bash
curl -fsSL https://github.com/agustinsacco/Phosphor/releases/latest/download/install.sh | sh
```

The script installs the AppImage on Linux and the `.app` bundle on macOS, and
verifies the download against the release's `checksums.txt`. Binaries are also
on the [Releases page](https://github.com/agustinsacco/Phosphor/releases): DMG
and ZIP for macOS, AppImage and `.deb` for Linux.

Windows builds are paused to keep CI fast and will return in a later release.
Existing Windows installs keep running the last Windows release; they find no
newer Windows update until builds resume.

Phosphor needs `pi` on your PATH:

```bash
npm install -g @earendil-works/pi-coding-agent
```

The app shows a setup screen until pi is available. Sign in by running `pi` in
Phosphor's built-in terminal and using `/login`, or configure API keys / a local
endpoint in `~/.pi/agent/`.

### Updates

Every green merge to `main` that changes the desktop app publishes a release,
versioned `0.1.<commit count>`, unless the commit has a `Skip-Release: true`
trailer. Site, schema, docs and CI-only merges don't release
([docs/nx-cache.md](docs/nx-cache.md#per-app-releases-and-deploys)). Each
release's notes list every pull request merged since the previous published
release, including skipped ones, since they ship in that build. An
installed app checks at launch and every 30 minutes, and shows an update button
in the sidebar footer above Settings when there's something new.

Linux AppImage, Windows and signed macOS installs download in the background
and offer "Restart to update". An unsigned macOS app swaps its own bundle and
relaunches. A `.deb` install, or a macOS bundle it can't write to, links to the
release page instead. Update checks only run in a packaged app. Details:
[docs/updates.md](docs/updates.md).

## How it works

One `pi --mode rpc` subprocess per live session, spoken to over JSONL on stdio.
Phosphor never imports pi's code. The protocol is hand-mirrored in
[`libs/shared/src/rpc.ts`](libs/shared/src/rpc.ts) with compile-time drift guards, so a protocol
change this file has not caught will not compile.

```mermaid
flowchart LR
  R["Renderer · apps/desktop/src/<br/>React, sandboxed, no Node"]
  M["Main · apps/desktop/electron/<br/>registry, pi client, fs, pty, updates"]
  P["pi --mode rpc<br/>one subprocess per session"]
  S[("~/.pi — sessions, models, MCP")]
  R -- "typed IPC (libs/shared/src/ipc.ts)" --> M
  M -- "JSONL over stdio" --> P
  P -- "providers, tools, files" --> S
```

Six facts that explain the rest:

1. **The main process owns all side effects.** The renderer runs sandboxed
   (`contextIsolation`, no Node) and is pure UI over typed IPC. Disk, network
   or a subprocess means `apps/desktop/electron/`, not `apps/desktop/src/`.
2. **IPC is a typed contract.** A new channel is an entry in `libs/shared/src/ipc.ts`'s
   `IpcInvokeMap`, a handler in the matching `apps/desktop/electron/ipc/<prefix>-handlers.ts`,
   and a case in `apps/desktop/src/dev/mockPhosphor.ts`.
3. **Stores (`apps/desktop/src/stores/`) are projections of main-process state**, not a
   second source of truth. The chat store keeps a session's live title, tokens
   and context meter honest while a turn runs.
4. **Sessions are files.** pi writes a session's JSONL when a turn _ends_. The
   sessions list is a scan of pi's session directory. Phosphor appends to those
   files for bookmarks, branch jumps and forks, which is only safe while no pi
   process owns the file.
5. **Six extensions run inside pi's process** (`libs/pi-extensions/pi-ext/`, loaded with `-e` into
   every session): `artifacts`, `context-breakdown`, `headroom`, `lane-reload`,
   `tool-name-guard`, `worktree-paths`. Two of them can change or refuse what
   the model did: [docs/extensions.md](docs/extensions.md).
6. **Failure is reported, not hidden.** Failures land on the session's chat;
   main-process detail goes to `phosphor.log`. For a bad session,
   [CLAUDE.md](CLAUDE.md#debugging-a-failing-session) has the three layers of
   evidence and the one command that decides Phosphor-vs-pi.

## Development

Requires Node 22+ (pi itself needs ≥ 22.19) and `pi` on PATH for `npm run dev`.

```bash
npm ci
npm ci --prefix apps/site
npm run dev
```

| Script               | Purpose                                                                   |
| -------------------- | ------------------------------------------------------------------------- |
| `npm run dev`        | Electron + Vite dev server with HMR                                       |
| `npm run dev:web`    | Renderer alone, in a browser, against the mock preload API                |
| `npm run build`      | Bundle main, preload and renderer to `apps/desktop/out/`                  |
| `npm run typecheck`  | All-file audit; Desktop/tests, libraries, Host, Control, tooling and site |
| `npm run lint`       | ESLint                                                                    |
| `npm run format`     | Prettier                                                                  |
| `npm test`           | Vitest unit tests                                                         |
| `npm run test:e2e`   | Playwright-Electron smoke tests against the deterministic `pi`            |
| `npm run validate`   | Check, test and build, quiet; one PASS/FAIL line per step + a log         |
| `npm run pack`       | Package for the current platform without packing (quick check)            |
| `npm run dist`       | Package for the current platform via electron-builder                     |
| `npm run shots`      | Deterministic screenshots against the e2e pi stub (see below)             |
| `npm run shots:live` | Re-shoot this README against a real pi instance (see below)               |

[Testing](docs/testing.md) is the contract for dependency installation, check
commands, typed test helpers, frozen interfaces, coverage evidence, size budgets
and staged lint warnings. Tests currently live beside their subjects as
`*.test.ts`; this is temporary until RL-03 moves them to `test/` folders.
Foundation and freeze suites already use the new layout.

### Nx task orchestration

Core Nx is pinned to `23.2.1`. Nx-scoped security overrides pin `axios` to
`1.20.0`, `brace-expansion` to `5.0.12` and `smol-toml` to `1.9.0`, overriding
upstream's exact vulnerable pins. Remove these overrides when a tested upstream
release fixes them. npm also hoists the `brace-expansion` security patch from
`5.0.9` to `5.0.12` for existing root `minimatch` consumers (ESLint and
app-builder-lib); this is the sole pre-existing dependency resolution change.
Older nested packaging dependencies still have baseline audit findings; the
Nx wrapper does not claim to fix those. Override API smoke tests use no network.

The original npm commands above remain the
validation and CI path. Optional `npm run nx:build`, `nx:typecheck`, `nx:lint`,
`nx:test`, `nx:test:e2e` and `nx:validate` wrap those same underlying commands,
without redirecting the original aliases to Nx. `npm run nx:graph` shows the
explicit current-path ownership graph; `npx nx show project tooling --json`
shows effective targets. `npm run nx:test -- --configuration=inventory` lists
the same full unit suites without running them.

| Project         | Current paths / ownership                                                             |
| --------------- | ------------------------------------------------------------------------------------- |
| `desktop`       | `apps/desktop/`, plus screenshot assets at `docs/img/`                                |
| `control`       | `apps/control/`, the site and control API ([control-plane.md](docs/control-plane.md)) |
| `host`          | `apps/host/`, the plain-Node Host CLI ([host.md](docs/host.md))                       |
| `runtime`       | `libs/session-runtime/src/`, including plain-Node and fake-pi tests                   |
| `shared`        | `libs/shared/`                                                                        |
| `pi-extensions` | `libs/pi-extensions/pi-ext/`, including optional extension tests                      |
| `site`          | `apps/site/`, with its independent install and lockfile                               |
| `schema`        | `supabase/`, with explicit start/test/stop lifecycle                                  |
| `tooling`       | `tools/scripts/`, including workspace-wide checks                                     |

Every target remains uncached, with conservative whole-workspace inputs,
including nested projects. Nx runs at most three tasks by default and bounds
each unit target to two Vitest workers. It has no inference plugins, daemon or
Cloud connection, and explicitly keeps default per-worktree cache/state in
ignored `.nx/`. No affected-only selection is introduced.
[nx-cache.md](docs/nx-cache.md) defines the cache ineligibility, declared outputs,
resource bounds and original uncached validation contract. Desktop owns its isolated native install
and lifecycle, described in [desktop-build.md](docs/desktop-build.md). Site targets use its existing npm commands from `apps/site/`, retaining
its social-image prebuild; schema targets retain the pinned local Supabase
commands and require explicit lifecycle cleanup. Neither is invoked by the
normal root validator unless its existing opt-in applies.

Project edges include source dependencies, extension resources, screenshot
assets, fixtures and workspace-wide tooling consumers, not just production
imports: the extensions project depends on shared because the optional
permission-gate test imports the shared command-approval parser, and tooling
checks consume all projects while Desktop uses tooling scripts. No library
depends on an app, so a Desktop-only change selects only `desktop` and
`tooling`, and a Host-only change only `host` and `tooling`. Targets have no recursive
`^test`/`^build` task dependencies, so their executable task graphs remain
acyclic. `tools/scripts/nx-projects.test.ts` checks the effective graph and targets,
including missing-edge/target fixtures. App-relative `out/`, packaging metadata and resource destinations are unchanged.
Root npm aliases delegate to Desktop; the app owns its Electron postinstall.
The root npm workspaces contain only `libs/shared`, `libs/session-runtime` and
`libs/pi-extensions`. Desktop, Control and the site retain independent locks and real
installation directories. The [installation contract](docs/installations.md)
defines the supported scoped source-production recipe, script suppression,
source bundling and native ABI separation. This is not universal single-lock
consolidation.

`@phosphor/shared` is a private source-only package at `libs/shared`. Its
explicit subpath exports cover the complete shared module set, with adjacent
tests excluded from exports. Electron main/preload and renderer/browser builds
bundle its sources, rather than requiring workspace TypeScript at runtime.
The existing `@shared/*` spelling is the sole compatibility alias, mapped to
`libs/shared/src` in TypeScript, Vitest and both Vite configurations. It remains supported by configured source builds; installation closure does not
require a semantic split or a repository-wide import rewrite.
`@phosphor/session-runtime` exports the Electron-free modules from
`libs/session-runtime/src`, with a standalone Node TypeScript configuration.
Desktop main/preload and the plain-Node acceptance fixtures bundle these source
exports, and the Host imports them. Tests and fake-pi fixtures remain adjacent but are not package exports.
Core Nx derives a static runtime-to-shared edge from the private package manifest;
the explicit implicit edge remains too. Graph checks require both edge types,
while comparing unique targets for reachability. No import-inference plugin is enabled.

Conventions (IPC channels, the `piCall` rule, modals, and the sharp edges worth
knowing before touching pi's session files) are in [CLAUDE.md](CLAUDE.md). It
is written for coding agents and is the shortest accurate orientation for a
human too.

### The screenshots in this README

They are captures of the app against a **real pi instance**: the developer's
own `~/.pi`, real signed-in providers, a real repo, two metered model turns.

```bash
npm run build && npm run shots:live
```

The live runner (`tools/scripts/capture-live-shots.mjs`) isolates app prefs but not
pi. It runs one small edit task in a disposable worktree and one artifact task,
then shoots the transcript, panes, menus and popovers. It spends real tokens
and leaves the sessions and worktree behind; delete them like any other
session. `ONLY=models,context` re-shoots a subset (the turns still run);
`WORKSPACE=… TASK_EDIT=… MODEL_ARTIFACT=…` re-aim it. Email addresses on
screen are masked before every shot, and `REDACT='from=to,…'` masks anything
else private, like an internal MCP server's name or host.

`npm run shots` (`tools/scripts/capture-readme-shots.mjs`) is the deterministic
sibling: same mechanics, scratch workspace, the e2e `pi` stub, no key, no
network. Use it to verify UI changes; use the live one to regenerate what this
README's feature gallery shows. The homepage and README opening use a different,
explicitly labelled source: reviewed Remote Hosts excerpts replayed in the actual
renderer, with private details removed and task labels expanded. No live agents
are started to produce that image. The fixture, reproduction script and exact
provenance live in [apps/site/README.md](apps/site/README.md#captures-and-privacy).

### Repo layout

This tree is the single source of truth for "what lives where". `CLAUDE.md` and
[docs/architecture.md](docs/architecture.md) link here rather than keeping
copies.

```
apps/desktop/electron/            main process — owns every side effect
  main.ts            app lifecycle, window creation, quit teardown
  preload.ts         the contextBridge surface (one typed `subscribe` helper)
  ipc.ts             composition root: calls the per-domain handler registrars
  ipc/               one module per channel-prefix family: 23 modules today
                     (account, app, artifacts, claude-auth, clipboard, control, feedback, fs, git,
                      maintenance, mcp, optimization, packages, pi-auth,
                      pi-config, pi-session, pty, routines, sessions, skills,
                      updates, voice, writing) plus handle.ts, the
                      envelope unwrapper. The contract lives in libs/shared/src/ipc.ts;
                      ipc.ts is the composition root, so a handler module
                      never imports it back.
  registry.ts        the live pi session registry
  routines/          local scheduler, SQLite run ledger, unattended execution,
                     background tray; never manages interactive lanes
  broadcast.ts       send a push to every open window
  pi/                desktop RPC adapter, session scanner, writer, paths,
                     print mode, model catalogue, login flow
  claude/            pi-claude-cli: several Claude Code logins side by side,
                     which one bills a session (decided once, at spawn), and
                     live subscription usage
  account/           optional Phosphor sign-in: GitHub through Supabase Auth
                     (PKCE, a one-shot loopback callback, the session in the
                     OS keychain, or a user-only file on Linux without a keyring);
                     the renderer never sees a token
  control/           main-only control API client for machine listing,
                     enrollment approval and removal (account preview)
  headroom/          Headroom proxy supervisor (adopt/spawn/kill) + install job
  optimization/      the Advisor rules engine (pure functions, advice only)
  voice/             voice input: pinned model download, the dictation service,
                     the utility process that runs the speech model (docs/voice.md)
  pty/               node-pty manager + spawn-helper repair
  fs/                file service, git service/sync/worktrees (over the
                     runtime library's git/),
                     workspace watcher, workspace search (worker thread)
  artifacts/         the `phosphor-artifact://` protocol — model HTML on its
                     own origin, so it runs JS without weakening the app CSP;
                     and thin wiring to the portable artifact indexer and library
                     in session-runtime
  maintenance/       worktree reclaim: a pure policy that judges, a sweep that
                     does the git and the disk, a scheduler that rate-limits it
  updates/           update check + download state machine
  writing/           the prompts autocomplete learns from (Settings → Writing)
  store.ts           app prefs (electron-store, constructed lazily)
libs/session-runtime/src/  Electron-free source modules, not a separate service
  pi/                pi RPC transport, strict LF JSONL framing, activity tracking,
                     session ownership, startup/policy preparation, command/resume
                     admission and deletion coordination with machine-local ports;
                     the reads behind those ports (pi settings, packages, versions,
                     forwarded env names)
  file-log.ts        injected file logging
  git/               the one git runner, repository/worktree info and its cache
  bundled-extensions.ts  bundled extension paths
supabase/            isolated control-directory migrations and local RLS tests
libs/shared/src/     types and pure logic shared by main + renderer
  ipc.ts             the typed IpcInvokeMap contract
  rpc.ts             hand-mirrored copy of pi's RPC protocol + drift guards
  models.ts          model catalogue and shared app types
  control-api.ts     control wire shapes, parsers, limits and Host signing string
  remote-host.ts     Host hello validation and host-qualified resource keys
apps/desktop/src/                 renderer (React) — pure UI over typed IPC
  app/               shell: App, TopBar, workspace picker, global shortcuts
  features/          one folder per surface (20): chat, sessions, files,
                     terminal, artifacts, settings, home, worktrees,
                     workspaces, palette, updates, connectors, extension-ui,
                     skills, routines, feedback, machines, account, voice,
                     writing
  components/        cross-feature primitives (Modal, PopupMenu, form, icons,
                     markdown renderers; search/: the find bar, its toggles,
                     finding and painting text in rendered DOM)
  stores/            zustand stores — projections of main-process state
  lib/               framework-free helpers (format, path, rpc, fuzzy, time…)
  styles/            the Phosphor design tokens
  assets/            the bundled fonts
  dev/               browser-only mock of the preload API (never bundled)
libs/pi-extensions/pi-ext/  the six pi extensions that run inside pi's process,
                     bundled into every session: artifacts, context-breakdown,
                     headroom, lane-reload, tool-name-guard, worktree-paths
apps/desktop/e2e/                 Playwright-Electron smoke tests + deterministic pi stub
apps/control/        plain-Node site and control API server; enrollment, machines,
                     clients, grants and Host routes (docs/control-plane.md)
apps/host/           the plain-Node Host and its `phosphor` CLI (src/, and
                     scripts/build.mjs for the bundle): its config, pi's
                     environment, machine checks, session runtime and signed
                     loopback API for grant-authenticated clients (docs/host.md)
tools/host-release/  signed Host bundles, pinned Node/native PTY, manifest and installer
tools/scripts/             install.sh, icon + screenshot generation, release and
                     validate helpers
docs/                living technical docs — one file per surface, each
                     rewritten in the same diff as the behaviour it describes;
                     plus known-issues.md (current defects) and future-features.md
                     (decided or explored directions that are not built)
docs/img/            the screenshots above (assets, not documentation)
apps/site/           phosphor.saccolabs.com — the Astro landing page, real
                     captures and browser checks; combined image in apps/control/Dockerfile (apps/site/README.md)
.infra/phosphor-site/  the k3s manifests the Deploy Site workflow applies
```

The main process owns all side effects. The renderer runs with
`contextIsolation`, no Node integration, and a strict CSP. Model-authored HTML
only ever renders inside a sandboxed iframe.

## Documentation map

| Read                                               | When                                                      |
| -------------------------------------------------- | --------------------------------------------------------- |
| [CLAUDE.md](CLAUDE.md)                             | Orientation, conventions, sharp edges, debugging          |
| [docs/README.md](docs/README.md)                   | The map: which file owns which fact                       |
| [docs/](docs/)                                     | How Phosphor works now (architecture, extensions, MCP, …) |
| [docs/known-issues.md](docs/known-issues.md)       | Defects that reproduce today, with the file that has them |
| [docs/architecture.md](docs/architecture.md)       | Process model, IPC design, cross-cutting requirements     |
| [docs/pi-integration.md](docs/pi-integration.md)   | pi's RPC protocol and session format                      |
| [docs/remote-access.md](docs/remote-access.md)     | Remote foundations and current execution boundary         |
| [docs/control-plane.md](docs/control-plane.md)     | Site and account API server                               |
| [docs/host.md](docs/host.md)                       | Host CLI and machine identity                             |
| [docs/future-features.md](docs/future-features.md) | Decided or explored directions, not built                 |

`docs/` describes current behaviour, present tense. A doc is part of the diff
that changes its behaviour, not a follow-up. There is no dated log and no spec
folder; git is the history. Two exceptions: [docs/known-issues.md](docs/known-issues.md)
records current defects; [docs/future-features.md](docs/future-features.md) records
decided or explored directions that are not built. A defect leaves its file when
fixed; a feature moves into its surface's living doc and leaves the future file
in the same diff that builds it.

## Contributing

Issues and PRs are welcome. Run `npm run validate` before opening a PR. If your
change moves behaviour a `docs/` file describes, update that file in the same
diff.

## License

MIT
