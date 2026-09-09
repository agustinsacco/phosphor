# 01 — Architecture

## Locked technical decisions

| Area                 | Decision                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| Shell                | Electron (current stable), TypeScript everywhere, strict mode                                       |
| Renderer             | React 19, Vite (electron-vite), Tailwind CSS 4                                                      |
| State                | Zustand (per-domain stores); no Redux                                                               |
| Code viewing/editing | Monaco Editor (also provides the diff editor)                                                       |
| Terminal             | xterm.js + node-pty (real PTY, user shell, full interactivity)                                      |
| Markdown             | Streaming-tolerant react-markdown pipeline (remark-gfm, remark-math, rehype-katex); Shiki           |
| Diagrams             | Mermaid, client-side                                                                                |
| Math                 | KaTeX (via remark-math + rehype-katex)                                                              |
| Charts               | Two fences: `chart` JSON → Chart.js, `vega-lite` JSON → vega-embed                                  |
| HTML preview         | `<iframe sandbox="allow-scripts">` over `phosphor-artifact://`, never `srcDoc`; Code/Preview toggle |
| File watching        | chokidar (main process)                                                                             |
| Packaging            | electron-builder → macOS (dmg+zip, arm64+x64), Linux (AppImage+deb), Windows (nsis)                 |
| Install              | GitHub Releases + `curl … install.sh \| sh` (`scripts/install.sh`)                                  |
| IPC                  | Typed contextBridge preload; renderer never touches Node APIs                                       |
| pi integration       | RPC subprocess, one `pi --mode rpc` per live session ([pi-integration.md](pi-integration.md))       |

## Process model

```
┌────────────────────────── Electron main ──────────────────────────┐
│  SessionRegistry     ptyManager    fs-service / git-service       │
│  (electron/registry) (pty-manager)  + workspace/session watchers  │
│        │                  │                    │                  │
│  PiRpcClient (1 per live session)          chokidar               │
│        │  spawn: pi --mode rpc -e <6 bundled pi-ext>              │
└────────┼──────────────────┼────────────────────┼──────────────────┘
         │   typed IPC (contextBridge preload; per-session channels)
┌────────┴──────────────────┴────────────────────┴──────────────────┐
│                      Renderer (React, sandboxed)                  │
│  Zustand stores: workspaces / sessions / chat / files / terminal  │
│                  / artifacts / settings / layout                  │
└───────────────────────────────────────────────────────────────────┘
```

The main-side names are literal: `SessionRegistry` (`electron/pi/session-registry.ts`,
single instance exported as `registry` from `electron/registry.ts`) holds every
live session ↔ `PiRpcClient` (`electron/pi/rpc-client.ts`) pair; `ptyManager`
(`electron/pty/pty-manager.ts`) owns the PTYs. There is no WorkspaceManager and
no SessionManager class — filesystem and git are plain function modules
(`electron/fs/fs-service.ts`, `git-service.ts`), and watching is two chokidar
users, `electron/fs/workspace-watcher.ts` for the file tree and
`electron/pi/session-watcher.ts` for the sessions dir.

- **Main process owns all side effects**: pi subprocesses, PTYs, filesystem, git, watchers, dialogs, app prefs.
- **Renderer is pure UI** over typed IPC. `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` (`electron/main.ts`), strict CSP in `src/index.html`. Model-authored HTML renders only in the sandboxed iframe — and only via a `phosphor-artifact://` URL, because a `srcdoc` document inherits the embedder's policy container and the app's own `script-src 'self'` would silently refuse every inline script (`src/components/SandboxedHtml.tsx`).
- **IPC design**: request/response methods (`invoke`) for commands, push channels (`send`) for streams. Namespace per domain, **17 prefixes today**: `pi:*` (session lifecycle, RPC passthrough, agent settings, provider login), `app:*` (prefs, dialogs, theme, drafts, sandboxes), `git:*` (including worktrees — there is no `worktrees:*`), `claude:*` (pi-claude-cli accounts, login, usage), `sessions:*` (on-disk scan, tree, fork/jump, delete), `mcp:*`, `fs:*`, `skills:*`, `packages:*`, `pty:*`, `headroom:*`, `updates:*`, `maintenance:*`, `gh:*`, `clipboard:*`, `optimization:*` (`optimization:stats`, one channel), `artifacts:*` (`artifacts:stageHtml`, one channel). Every message type is declared in [`shared/ipc.ts`](../shared/ipc.ts) — count prefixes there, not here, if the two ever disagree.
- **Data flow for one streamed prompt**: renderer `pi:command` with `{type:"prompt"}` → main writes one JSONL line to child stdin → child stdout events parsed by `PiRpcClient` → forwarded on `pi:event:<sessionId>` (`sessionEventChannel()` in `shared/ipc.ts`) → `reduceChatEvent` (`src/features/chat/reducer.ts`) folds events into message view-models → virtualized list renders deltas.

## Repo layout

**See the tree in [the README](../README.md#repo-layout).** It used to be
duplicated here; the copy drifted (it named a `types/ipc.ts` that never existed,
listed 6 of the feature folders, and 2 pi extensions), so this section is a
pointer now. As of today `src/features/` has **14** folders (artifacts, chat,
connectors, extension-ui, files, home, palette, sessions, settings, skills,
terminal, updates, workspaces, worktrees) and `pi-ext/` has **6** modules —
`artifacts`, `context-breakdown`, `worktree-paths`, `tool-name-guard`,
`mcp-status`, `headroom` — **all six** loaded into every session by
`bundledExtensions()` in `electron/ipc/pi-session-handlers.ts`. Those two
numbers move; the tree in the README is the thing to re-read, not this
paragraph.

## Cross-cutting requirements

- Single source of truth for session state lives in main (`SessionRegistry`: live sessions ↔ pi children); renderer stores are projections.
- All long/streaming output is incrementally reduced — never rebuild whole message arrays per delta.
- Every feature works on macOS, Linux, Windows (path handling via `node:path`, PTY shells per-OS: `$SHELL` / PowerShell).
- App prefs in electron-store — `AppPrefs` in [`shared/models.ts`](../shared/models.ts): theme, recent/last workspace, last + pinned sessions, model picks, lane markers and `lanes`, `fonts` (UI scale and the three font sizes), agent directives (global and per-project), worktrees, maintenance, headroom. **Pane layout is not among them**: it is per-session and lives in `localStorage` under `phosphor-pane-layout` (`src/stores/layout.ts`), because it is view state that should not survive a prefs migration or cost an IPC round-trip per drag.
- Prefs are never written into pi's config files. pi config editing is explicit and user-initiated ([settings.md](settings.md)).
