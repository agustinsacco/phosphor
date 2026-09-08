<picture>
  <source media="(prefers-color-scheme: dark)" srcset="build/icon.svg">
  <source media="(prefers-color-scheme: light)" srcset="build/icon-light.svg">
  <img src="build/icon.svg" alt="pidex" width="88" height="88">
</picture>

# pidex

**The [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent),
extended into a desktop IDE for macOS, Linux and Windows — the most advanced
multi-provider agentic IDE you can run on your own machine.**

[![CI](https://github.com/agustinsacco/pidex/actions/workflows/ci.yml/badge.svg)](https://github.com/agustinsacco/pidex/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/agustinsacco/pidex?label=release&color=ffbe5c)](https://github.com/agustinsacco/pidex/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/agustinsacco/pidex/total?label=downloads)](https://github.com/agustinsacco/pidex/releases)
![License: MIT](https://img.shields.io/badge/license-MIT-8ec9a0)

Open a project folder, describe a task, and work alongside the agent — with a
chat that renders what models actually produce (diffs, diagrams, charts,
sandboxed HTML), the file explorer and terminal next to it, and every change the
agent made available to review or revert.

One window, every provider pi speaks: Anthropic, OpenAI (API key or ChatGPT
subscription), Google Gemini and Vertex, Azure OpenAI, Amazon Bedrock, Mistral,
Groq, Cerebras, xAI, OpenRouter, the Cloudflare and Vercel gateways — plus your
Claude Pro/Max subscription through
[pi-claude-cli](https://github.com/agustinsacco/pi-claude-cli), no API key
needed. Switch models mid-session and the conversation carries over.

|                                             |                                         |
| ------------------------------------------- | --------------------------------------- |
| **Chat, diffs, files, terminal, artifacts** | One window, side by side                |
| **Multi-provider by design**                | Any pi provider, switchable mid-session |
| **Sessions are real pi processes**          | Nothing invented, everything reachable  |
| **Runs on your metal**                      | Your models, your keys, your files      |

![A session with the activity run open on an edit's diff](docs/img/chat.png)

## Quick start

```bash
# 1. pi is the engine — pidex needs it on your PATH (Node ≥ 22.19)
npm install -g @earendil-works/pi-coding-agent

# 2. Install pidex (macOS / Linux; Windows builds are on tagged releases)
curl -fsSL https://github.com/agustinsacco/pidex/releases/latest/download/install.sh | sh
```

Launch pidex, open a project folder, and sign in to a provider: open the
built-in terminal, run `pi`, and use `/login` — or configure API keys / a local
endpoint in `~/.pi/agent/`. Then describe a task in the composer and press
Enter. Details and alternative installs are under [Install](#install).

## What pidex does

- **Sessions are real pi subprocesses.** One `pi --mode rpc` per live session,
  spawned in the workspace folder. Everything pi exposes over RPC is reachable
  from the UI — models, thinking levels, steering and follow-up queues,
  compaction, auto-retry, forks, clones, session export.
- **No permission prompts.** pi runs in full-permission mode; tool calls execute
  and stream their results.
- **Rich responses are first-class.** GFM markdown, syntax-highlighted code,
  mermaid diagrams, Chart.js and Vega-Lite specs, KaTeX math, and model-authored
  HTML rendered in a sandboxed iframe.
- **Every change is reviewable.** The Changes panel accumulates the agent's
  edits with per-file diffs against a session baseline, and per-file revert.
- **Session tree.** Visualize the branch structure of a session, jump to any
  point, fork from it, or bookmark it.
- **Artifacts.** A bundled pi extension adds `artifact_create` /
  `artifact_edit` / `artifact_update` tools; substantial deliverables land in a
  versioned side panel with previews and diffs between versions, and survive app
  restarts via session replay.
- **Your machine, your models.** Sign in to providers, pick models, set themes,
  and mount MCP servers from Settings. MCP OAuth is owned by the adapter, never
  by pidex: [docs/mcp.md](docs/mcp.md).

## The screens

Every session pairs the transcript with one switchable pane — Files, Changes,
Terminal or Artifacts. Each pane docks right or left of the chat (your pick,
persisted per session) and can go fullscreen. Every shot below is a capture of
the app running against a real pi instance — real providers, real sessions,
real tokens — see
[the screenshots in this README](#the-screenshots-in-this-readme).

### Home — where a session starts

The home screen starts a session: pick the folder, the branch (or a fresh
worktree branch off trunk), the model, and go. The sidebar carries every
session — live state, edit counts, worktree badge, and the PR badge once one
exists.

Above the composer sits the **lane board**: this project's lanes in columns by
what they need from you — waiting on you, ready to merge, needs a push, in
review, running — each card carrying the one action that unblocks it. Below it
a **ledger** of what the parallelism costs: spend, tokens, live processes, and
the account window that will stop you first.

Nothing there polls or spends tokens. Every column is derived from state the
renderer already holds (the session scan, git, `gh`, the dialog store), so the
board is correct with no live session and after a restart.

![Home over the real sessions of a repo](docs/img/home.png)

### Chat — the transcript, not a blob

Streaming assistant text with the run's activity folded into steps: file edits
expand to their diff, tool calls to their arguments and output, thinking to its
own block. The composer takes `@` file references, `/` commands, `!` shell
lines, and queues follow-ups while a turn is running.

![A finished turn: the activity run expanded on the edit's diff, Changes panel open beside it](docs/img/changes.png)

### The composer — every model, every provider, one chip away

The model chooser lists everything you are signed into — pi's native providers
and installed provider packages alike — searchable, starrable, switchable
mid-session. The chip names what actually serves the session (`via
pi-claude-cli` when it is your Claude subscription, not the API):

![The model menu open over the composer](docs/img/models.png)

Models with a thinking ladder get a second chip for effort:

![The thinking-level menu](docs/img/thinking.png)

The context meter opens into a live breakdown of the window — what the system
prompt, tools and conversation actually cost, and your plan's rate-limit
window on subscription providers:

![The context meter popover](docs/img/context.png)

`/` opens commands, `@` mentions workspace files:

![The slash-command menu](docs/img/commands.png)

![The @ file-mention menu, resolved against the workspace](docs/img/mentions.png)

### Files — explorer and editor, on whichever side you like

A file explorer with creation, rename, Trash, multi-selection, copy/cut/paste,
and file/folder drops, beside a Monaco editor. Switch it in from the session's
top bar; docked on the right by default. [File management details](docs/files.md):

![The files pane on the right: explorer and Monaco editor beside the transcript](docs/img/files.png)

One click moves the pane to the left of the transcript — the orientation is
per-session and persists:

![The same files pane docked on the left of the chat](docs/img/files-left.png)

And any pane can take over the whole session region when the transcript is not
the thing you're reading:

![The files pane fullscreened over the session](docs/img/files-full.png)

### Terminal — real shells in the workspace

Real terminal tabs running against the workspace, keyed per workspace like the
files pane, so the transcript never loses its place.

![A terminal tab open against the workspace, beside the transcript](docs/img/terminal.png)

### Artifacts

Long-form documents, HTML pages, SVG, mermaid and chart documents the model
creates for you — versioned, previewable, diffable, and reconstructed from the
session on reopen.

![A long document open in the artifacts pane](docs/img/artifacts.png)

### Settings — and it is not only dark

Ten tabs: appearance (theme, UI scale, fonts), agent, accounts, extensions,
connectors, MCP, workspaces, advanced, keybindings, about. Light theme
included, because diff review at 2am is a real workflow.

![The Appearance tab](docs/img/settings.png)

Accounts is where providers sign in — subscription login or API key, per
provider:

![The Accounts tab with signed-in providers](docs/img/accounts.png)

Connectors mounts MCP servers (Notion, Linear, and anything else with an MCP
endpoint); OAuth is owned by the adapter, never by pidex:

![The Connectors tab](docs/img/connectors.png)

And the light theme, on the artifact session:

![The session in the light theme](docs/img/light.png)

## Install

macOS and Linux:

```bash
curl -fsSL https://github.com/agustinsacco/pidex/releases/latest/download/install.sh | sh
```

The script installs the AppImage on Linux and the `.app` bundle on macOS,
verifying the download against the release's `checksums.txt`. Binaries are also
on the [Releases page](https://github.com/agustinsacco/pidex/releases) — DMG and
ZIP for macOS, AppImage and `.deb` for Linux.

Windows builds are produced by the tagged `Release` workflow rather than the
per-merge one, so a `.exe` is only present on releases that were cut from a `v*`
tag.

pidex needs `pi` on your PATH:

```bash
npm install -g @earendil-works/pi-coding-agent
```

The app shows a setup screen until pi is available. Sign in to a provider by
running `pi` in pidex's built-in terminal and using `/login`, or configure API
keys / a local endpoint in `~/.pi/agent/`.

### Updates

Every merge to `main` that passes CI publishes a new release, versioned
`0.1.<commit count>`. An installed app checks for one at launch and every 30
minutes after; when it finds one, an update button appears in the sidebar
footer, just above Settings.

Linux AppImage and signed macOS installs download in the background and offer
"Restart to update". Unsigned macOS and `.deb` installs cannot replace their own
files, so they link to the release page instead. Update checks are disabled
entirely in development builds — they only run when packaged.

## How it works

One `pi --mode rpc` subprocess per live session, spoken to over JSONL on stdio.
pidex never imports pi's code: the protocol is hand-mirrored in
[`shared/rpc.ts`](shared/rpc.ts) with compile-time drift guards, so a change to
pi's protocol that this file hasn't caught won't compile.

```mermaid
flowchart LR
  R["Renderer · src/<br/>React, sandboxed, no Node"]
  M["Main · electron/<br/>registry, pi client, fs, pty, updates"]
  P["pi --mode rpc<br/>one subprocess per session"]
  S[("~/.pi — sessions, models, MCP")]
  R -- "typed IPC (shared/ipc.ts)" --> M
  M -- "JSONL over stdio" --> P
  P -- "providers, tools, files" --> S
```

Six facts that explain the rest:

1. **The main process owns all side effects.** The renderer runs sandboxed
   (`contextIsolation`, no Node) and is pure UI over typed IPC. If a feature
   needs disk, network, or a subprocess, it goes in `electron/`, not `src/`.
2. **IPC is a typed contract.** A new channel is an entry in `shared/ipc.ts`'s
   `IpcInvokeMap`, a handler in the `electron/ipc/<prefix>-handlers.ts` module
   matching the prefix, and a case in `src/dev/mockPidex.ts`.
3. **Stores (`src/stores/`) are projections of main-process state**, not a second
   source of truth. The zustand chat store is what keeps a session's live title,
   tokens, and context meter honest while a turn is running.
4. **Sessions are files.** pi writes a session's JSONL when a turn _ends_; the
   sessions list is a scan of pi's session directory. pidex also appends to those
   files for bookmarks, branch jumps and forks — which is only safe while no pi
   process owns the file, and call sites enforce that by convention.
5. **Five extensions run inside pi's process** (`pi-ext/`, loaded with `-e`
   into every session): `artifacts`, `context-breakdown`, `mcp-status`,
   `tool-name-guard`, `worktree-paths`. Two of them can change or refuse what
   the model did — read
   [docs/extensions.md](docs/extensions.md) first.
6. **Failure is reported, not hidden.** Failures surface on the session's chat;
   main-process detail goes to `pidex.log`. When diagnosing a bad session,
   [CLAUDE.md](CLAUDE.md#debugging-a-failing-session) has the three layers of
   evidence and the one command that decides pidex-vs-pi.

## Development

Requires Node 22+ (pi itself requires Node ≥ 22.19) and `pi` on PATH for
`npm run dev`.

```bash
npm install
npm run dev
```

| Script               | Purpose                                                        |
| -------------------- | -------------------------------------------------------------- |
| `npm run dev`        | Electron + Vite dev server with HMR                            |
| `npm run dev:web`    | Renderer alone, in a browser, against the mock preload API     |
| `npm run build`      | Bundle main, preload and renderer to `out/`                    |
| `npm run typecheck`  | TypeScript project checks (main + renderer)                    |
| `npm run lint`       | ESLint                                                         |
| `npm run format`     | Prettier                                                       |
| `npm test`           | Vitest unit tests                                              |
| `npm run test:e2e`   | Playwright-Electron smoke tests against the deterministic `pi` |
| `npm run validate`   | All of the above, quiet — one PASS/FAIL line per step + a log  |
| `npm run pack`       | Package for the current platform without packing (quick check) |
| `npm run dist`       | Package for the current platform via electron-builder          |
| `npm run shots`      | Deterministic screenshots against the e2e pi stub (see below)  |
| `npm run shots:live` | Re-shoot this README against a real pi instance (see below)    |

Tests live beside their subject as `*.test.ts`, in `electron/`, `shared/` and
`pi-ext/` included.

**Conventions** (IPC channels, the `piCall` rule, modals, and the sharp edges
worth knowing before you touch pi's session files) live in
[CLAUDE.md](CLAUDE.md). It is written for coding agents, but it is the shortest
accurate orientation for a human too.

### The screenshots in this README

They are captures of the app running against a **real pi instance** — the
developer's own `~/.pi`, real signed-in providers, a real repo as the
workspace, and two genuinely metered model turns:

```bash
npm run build && npm run shots:live
```

The live runner (`scripts/capture-live-shots.mjs`) isolates app prefs (so it
never fights an installed pidex) but deliberately not pi: it runs one small
edit task in a disposable git worktree and one artifact task, then shoots the
transcript, panes, menus and popovers those turns produced. It spends real
tokens and leaves the two sessions and the worktree behind — that is the
point; delete them like any other session. `ONLY=models,context` re-shoots a
subset, `WORKSPACE=… TASK1=… MODEL2=…` re-aim it.

There is also a deterministic runner, `npm run shots`
(`scripts/capture-readme-shots.mjs`): same capture mechanics, but a scratch
workspace and the CI e2e suite's `pi` stub — no key, no network, model chip
reads _Stub Model_. Use it to verify UI changes reproducibly; use the live
one to regenerate what this README shows.

### Repo layout

This tree is the single source of truth for "what lives where". `CLAUDE.md` and
[docs/architecture.md](docs/architecture.md) link here
rather than keeping their own copies — there used to be three, and all three had
drifted.

```
electron/            main process — owns every side effect
  main.ts            app lifecycle, window creation, quit teardown
  preload.ts         the contextBridge surface (one typed `subscribe` helper)
  ipc.ts             composition root: calls the per-domain handler registrars
  ipc/               one module per channel-prefix family — 13 of them today
                     (app, claude-auth, clipboard, fs, git, mcp, packages,
                      pi-auth, pi-config, pi-session, pty, sessions,
                      updates) plus handle.ts, the envelope unwrapper. The
                     contract lives in shared/ipc.ts; ipc.ts is the composition
                      root, so a handler module never imports it back.
  registry.ts        the live pi session registry
  broadcast.ts       send a push to every open window
  pi/                RPC client (strict LF JSONL framing), session scanner,
                     writer, paths, print mode, model catalogue, login flow
  pty/               node-pty manager + spawn-helper repair
  fs/                file service, git layer (git-exec/info/sync/worktrees),
                     workspace watcher
  updates/           update check + download state machine
  store.ts           app prefs (electron-store, constructed lazily)
shared/              types and pure logic shared by main + renderer
  ipc.ts             the typed IpcInvokeMap contract
  rpc.ts             hand-mirrored copy of pi's RPC protocol + drift guards
  models.ts          model catalogue and shared app types
src/                 renderer (React) — pure UI over typed IPC
  app/               shell: App, TopBar, workspace picker, global shortcuts
  features/          one folder per surface: chat, sessions, files, terminal,
                     artifacts, settings, home, worktrees, workspaces,
                     palette, updates, connectors, extension-ui
  components/        cross-feature primitives (Modal, PopupMenu, form, icons,
                     markdown renderers)
  stores/            zustand stores — projections of main-process state
  lib/               framework-free helpers (format, path, rpc, fuzzy, time…)
  styles/            the Phosphor design tokens
  dev/               browser-only mock of the preload API (never bundled)
pi-ext/              the five pi extensions that run inside pi's process,
                     bundled into every session: artifacts, context-breakdown,
                     mcp-status, tool-name-guard, worktree-paths
e2e/                 Playwright-Electron smoke tests + deterministic pi stub
scripts/             install.sh, icon + screenshot generation, release and
                     validate helpers
docs/                how pidex works now; docs/log dated history;
                     docs/specs deferred work — see docs/README.md
docs/img/            the screenshots above (assets, not documentation)
```

The main process owns all side effects. The renderer runs with
`contextIsolation`, no Node integration, and a strict CSP; model-authored HTML
only ever renders inside a sandboxed iframe.

## Documentation map

| Read                                           | When                                                    |
| ---------------------------------------------- | ------------------------------------------------------- |
| [CLAUDE.md](CLAUDE.md)                         | Orientation, conventions, sharp edges, debugging        |
| [docs/README.md](docs/README.md)               | The map: what is current behaviour and what is deferred |
| [docs/](docs/)                                 | How pidex works now (architecture, extensions, MCP, …)  |
| [docs/log/](docs/log/)                         | Dated notes on what changed and why                     |
| [docs/specs/TRACKER.md](docs/specs/TRACKER.md) | Phases and their logs                                   |
| [docs/specs/](docs/specs/)                     | Deferred work: findings, backlog, build intent          |

`docs/` is current behaviour. `docs/specs/build/` is a dated design doc;
reading one as current is how stale conclusions survive.

## Contributing

Issues and PRs are welcome. Run `npm run validate` before opening a PR, and
write a `docs/log/` note for a substantial feature or refactor.

## License

MIT
