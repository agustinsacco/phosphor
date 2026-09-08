# CLAUDE.md

pidex is an Electron desktop app that wraps the **pi coding agent**
(`@earendil-works/pi-coding-agent`) — one `pi --mode rpc` subprocess per live
session, spoken to over JSONL on stdio. pidex never imports pi's code; the
protocol is hand-mirrored in `shared/rpc.ts`.

**Two maps before you start.** [README.md](README.md#repo-layout) has the repo
tree — the single copy, since three copies drifted.
[docs/README.md](docs/README.md) is the documentation index: `docs/` is how
pidex behaves **now**, `docs/log/` is dated history, and `docs/specs/` is work
not yet done. Reading a `docs/specs/build/` doc as current is how the
terracotta-vs-Phosphor contradiction survived 20 days.

## Commands

```bash
npm run dev        # Electron + Vite with HMR (needs pi on PATH; see below)
npm run typecheck  # tsc for main (tsconfig.node) + renderer (tsconfig.web)
npm run lint       # eslint
npm run format     # prettier --write
npm test           # vitest unit tests
npm run test:e2e   # builds, then Playwright-Electron against the pi stub
npm run validate   # all of the above, quiet: PASS/FAIL summary + a log file
```

CI runs typecheck, lint, `prettier --check .`, unit tests, build, and the e2e
matrix (ubuntu + macOS). Run typecheck + lint + test before considering a
change done; run e2e when touching IPC, session lifecycle, or visible UI flow.

`npm run validate` (`scripts/validate.sh`) is the one to reach for when you
just want a verdict: it prints one line per step and sends everything else to
`$VALIDATE_LOG` (default `/tmp/pidex-validate-$$.log`). `SKIP_E2E=1` stops
before the slow part.

**E2E windows never appear on your screen**, so a background agent running the
suite can't steal focus mid-keystroke. `scripts/e2e.sh` prefers `xvfb-run`
(real windows on a virtual display, full speed — install with
`sudo apt install xvfb`) and otherwise leaves the windows unmapped
(`hideWindowsForE2E` in `electron/window-chrome.ts`), which is ~2-3x slower
because Chromium deprioritizes rendering for a window that was never shown.
`PIDEX_E2E_SHOW=1 npm run test:e2e` puts them back on your real display when
you want to watch.

## Architecture in six facts

1. **The main process owns all side effects.** The renderer runs sandboxed
   (contextIsolation, no Node) and is pure UI over typed IPC. If a feature
   needs disk/network/subprocess, it goes in `electron/`, not `src/`.
2. **IPC is a typed contract.** A new channel = an entry in
   `shared/ipc.ts` `IpcInvokeMap` + a handler in
   `electron/ipc/<prefix>-handlers.ts` (the module matching the channel prefix
   — 14 of them, listed in [README.md](README.md#repo-layout)) + a case in
   `src/dev/mockPidex.ts` if the browser harness should exercise it.
   `electron/ipc.ts` is only the composition root; the session registry lives
   in `electron/registry.ts` so handlers never import their composition root.
3. **RPC to pi goes through `src/lib/rpc.ts`** (`piCall` / `piCallOk`), which
   unwraps the `{success, data?, error?}` envelope and surfaces failures on
   the session's chat. Calling `window.pidex.piCommand` directly means you own
   the error branch — half the original call sites forgot, so don't.
4. **`shared/rpc.ts` is a mirror of pi's protocol** with compile-time drift
   guards (`_NoMissingResponseKeys` / `_NoExtraResponseKeys`). Adding an RPC
   command means updating both the command union and `RpcResponseDataMap`, or
   it won't compile — that's intentional.
5. **Every session is independent.** There is no cross-session manager: no
   fleet hub, no orchestrator thread, no automatic reclamation of an idle
   session's subprocess. Sessions are created from the renderer, and
   `electron/registry.ts` is the only thing that knows what is running.
   Removed 2026-09-03; see
   [docs/log/2026-09-03-remove-orchestration.md](docs/log/2026-09-03-remove-orchestration.md).
6. **Stores (`src/stores/`, zustand) are projections of main-process state.**
   `files.ts` and `terminal.ts` are keyed `byWorkspace[path]`; their
   `workspaceFiles()` / `workspaceTerminals()` selectors return a shared
   frozen empty value — never mutate it, never inline a fresh `{}` in a
   selector. "Which workspace am I in?" is `useActiveWorkspace()` (derived,
   prefers the active session's own cwd) — not a global current-workspace.

## Sharp edges (read before touching)

- **`electron/pi/session-writer.ts` appends to pi's own session files**
  (bookmarks, branch jumps, forks). It is only safe while no pi process owns
  the file — call sites enforce this by convention. It depends on pi's on-disk
  format staying stable. Tests: `electron/pi/session-writer.test.ts`.
- **JSONL framing is strict LF via `JsonlDecoder`, never `readline`** —
  U+2028/U+2029 are legal inside JSON strings and readline splits on them.
- **`electron/pi/pi-paths.ts` is the single source of truth** for pi's session
  directory layout and cwd mangling (`realpathSync.native` first — pi resolves
  symlinks). The e2e stub duplicates the mangling in
  `e2e/fixtures/pi-stub.cjs`; keep them in sync.
- **`pi -p` blocks until stdin reaches EOF, so it must never be run through
  `execFile`/`exec`.** Both leave the child's stdin an open pipe, and pi then
  sits there until the caller's timeout — silently, with empty stdout and empty
  stderr. That killed session auto-naming outright for weeks: no session was
  ever named and no branch was ever renamed. Spawn print-mode runs through
  `electron/pi/print-mode.ts` (`stdio[0] = 'ignore'`). The e2e stub cannot
  catch a regression — it prints and exits without reading stdin — so the guard
  is `electron/pi/print-mode.test.ts`. See
  [docs/log/2026-08-26-session-start-ux.md](docs/log/2026-08-26-session-start-ux.md).
- **pi writes a session's file only when a turn ENDS**, not incrementally. A
  name set mid-turn does not reach the disk scan until the reply lands, so
  every surface showing a LIVE session's title prefers the chat store's
  `meta.sessionName` over the scanned `meta.name`, and a session keeps its
  placeholder sidebar row (`PendingSessionRow`) for the whole first turn.
- **`electron/store.ts` constructs its electron-store lazily on purpose** —
  a module-scope `new Store()` would resolve `userData` before main.ts can
  redirect it for E2E, leaking test state into real prefs.
- **E2E env hooks (`PIDEX_PI_STUB`, `PIDEX_E2E_WORKSPACE`,
  `PIDEX_TEST_USER_DATA`) must stay gated on `!app.isPackaged`.** Ungated,
  they are env-var-triggered code execution in the main process of a shipped
  app (fixed once; don't regress it).
- **`bootstrapSession` learns a session's file path asynchronously** (from
  `get_state`), so last-session persistence happens in two places in
  `src/stores/sessions.ts` — read the comments there before "simplifying".
- Session-dir watchers are per-workspace chokidar handles tied to sidebar
  group visibility (expanded ⇒ watched, collapsed ⇒ unwatched, all closed on
  quit). Don't add unbounded watch paths.
- **Not every session was produced by a pi-native provider.** Sessions run on
  the Claude Code provider (`@saccolabs/pi-claude-cli`) contain block shapes
  pi itself never emits: CLI-side tools arrive as `[Claude Code · Name {…}]`
  marker text blocks (a wire contract — `parseExternalToolMarker` turns them
  into activity steps), and some models emit thinking with a signature and no
  plaintext. Before touching transcript rendering, tool UX or subagent UI,
  read [docs/extensions.md](docs/extensions.md#how-provider-transcripts-render).
- **Claude sessions run through a SEPARATELY VERSIONED package**, and
  pidex pins nothing. `@saccolabs/pi-claude-cli` is installed into pi
  (`~/.pi/agent/npm/node_modules/`), so token behaviour, session resume and
  filler bugs all live outside this repo. Check what is actually installed
  before diagnosing a Claude-provider session:

  ```bash
  jq -r .version ~/.pi/agent/npm/node_modules/@saccolabs/pi-claude-cli/package.json
  npm view @saccolabs/pi-claude-cli version   # what is published
  ```

  A fix merged there is NOT live until it is published _and_ reinstalled —
  0.4.8 sat merged-but-unpublished for a day while sessions kept dying, because
  the publish workflow only ships a version npm does not already have.
  Rate-limit percentages need >= 0.4.9. **A session on < 0.4.16 never receives
  pi's system prompt at all, on any turn** — `--system-prompt`/
  `--append-system-prompt` take a literal string, and every version through
  0.4.15 passed them a temp-file path instead, so the CLI ran on its own
  default instructions from turn 1 onward. (0.4.15 also fixed a _cache-cost_
  bug — the flag wasn't re-sent across `--resume` — but re-sent the same
  broken flag, so it didn't fix the missing instructions.) If a session
  doesn't honour its charter at all, or stops after turn 1, check the
  installed version first: `>= 0.4.16` is required for both. **`>= 0.5.1`**
  is required for MCP isolation: pidex sets `PI_CLAUDE_CLI_STRICT_MCP=1` on
  every Claude session so the CLI cannot load the user's own MCP servers
  alongside pi's, and older versions ignore it. **`>= 0.6.1`** is required
  after a compaction: below it the first message (often the second too) does
  nothing, because the CLI answers its own queued `<task-notification>` first
  and the provider read that empty `result` as the end of the turn. The same
  bug re-billed the whole conversation as a cache write on the next resume.
  **`>= 0.7.0`** keeps ONE CLI
  process per session (proxied tool handoffs, parked between turns); below
  it every pi-side tool call and every turn restarts the CLI, and Claude
  Code's system prompt embeds a git snapshot, so every commit or branch
  rename in between re-bills the whole context as cache write. That park is
  also why **every one-shot `pi -p` spawn must pass `claudeOneShotEnv()`**
  (`PI_CLAUDE_CLI_KEEPALIVE_MS=0`): a parked child holds pi's event loop
  open, so a naming run prints its title and then does not exit for ten
  minutes. That silently killed session auto-naming, and with it every branch
  rename, the hour 0.7.0 was installed. See
  [docs/log/2026-08-29-claude-cli-lifecycle-verification.md](docs/log/2026-08-29-claude-cli-lifecycle-verification.md)
  and
  [docs/log/2026-09-02-persistent-claude-cli.md](docs/log/2026-09-02-persistent-claude-cli.md)
  and
  [docs/log/2026-09-04-naming-hang-on-parked-cli.md](docs/log/2026-09-04-naming-hang-on-parked-cli.md)
  and
  [docs/log/2026-09-03-post-compaction-stall-and-context-meter.md](docs/log/2026-09-03-post-compaction-stall-and-context-meter.md).

- **pidex ships five extensions that run inside pi's process** (`pi-ext/`,
  loaded with `-e` into every session; listed in `bundledExtensions()` in
  `electron/ipc/pi-session-handlers.ts`). They are the only pidex code with a
  say inside a turn, and two of them can change or refuse what the model did:
  - **`worktree-paths.ts` can refuse a tool call.** It blocks a
    `read`/`write`/`edit`/`ls`/`grep`/`find` whose path escapes a worktree
    session into the repo's main checkout (a different branch) when the same
    file exists in the worktree —
    models were doing this silently and answering about the wrong branch. The
    four conditions in that file are deliberately narrow; widening them blocks
    legitimate reads, because pi's own prompt sends the model to absolute paths
    outside the cwd for its docs. See
    [docs/log/2026-08-22-worktree-path-leak.md](docs/log/2026-08-22-worktree-path-leak.md).
  - **`tool-name-guard.ts` rewrites a malformed tool call** at `message_end`,
    before pi persists it. A model can emit a tool call whose _name_ is not a
    tool name (seen: `mcp({})<tool_call>find`, raw syntax leaked into the name
    field). pi tolerates it in the moment and writes it to the session file —
    and then every later turn replays it and the provider rejects the whole
    request (`Member must satisfy regular expression pattern: [a-zA-Z0-9_-]+`),
    bricking the thread permanently. The guard turns it into plain text.
    See [docs/log/2026-08-26-orchestrator-controls.md](docs/log/2026-08-26-orchestrator-controls.md).
- **Three UI surfaces are fed by extensions, not by RPC.** The context meter's
  composition section comes from `pi-ext/context-breakdown.ts` (bundled, `-e`
  into every session), its plan-limits section from the Claude provider
  package, and per-server MCP state from `pi-ext/mcp-status.ts` — all over
  `ctx.ui.setStatus` into `stores/extensionUi.ts`. The provider one crosses a
  repo boundary, so nothing here fails to compile when it
  changes; the keys and their rules are in
  [docs/extensions.md](docs/extensions.md#the-status-channel-is-a-wire-contract).
  Component sizes in that breakdown are estimates and must stay labelled as
  such — only pi's total is authoritative.
- **macOS updates itself by replacing its own bundle**, because Squirrel.Mac
  refuses the ad-hoc signature this repo ships (`electron/updates/mac-installer.ts`).
  Staging lives BESIDE the installed `.app`, not in `/tmp`, so the swap is two
  atomic same-volume renames with a rollback — and the relauncher must poll for
  the old pid to exit, or the single-instance lock in `main.ts` kills the new
  instance and the user is left with no app. The startup sweep that deletes
  leftovers is `rm -rf` next to `/Applications`; its name match is a full-string
  regex on purpose. See [docs/updates.md](docs/updates.md).
- **Connecting an MCP server never puts a token in pidex.** The adapter owns
  OAuth and the OS credential store; pidex writes `mcp.json` and drives the
  adapter's own `/mcp-auth` command (an extension command, so no model runs).
  And it must **never auto-answer** the adapter's "paste the callback URL"
  prompt: pi's RPC has no dialog cancel, so an empty answer wins the race
  against the loopback callback and kills a flow that already succeeded. See
  [docs/mcp.md](docs/mcp.md#connectors-settings--connectors).

## Conventions

- Tests live beside their subject as `*.test.ts` — **everywhere**, `electron/`
  and `shared/` and `pi-ext/` included. One `__tests__/` directory is left
  (`scripts/__tests__/`); the rest were moved next to their subjects. Shared
  inputs go in a sibling `__fixtures__/`.
  DOM suites opt in per file with `// @vitest-environment jsdom`. Prefer
  testing pure logic extracted into `src/lib/` / plain modules over component
  tests.
- Modals use `ModalOverlay` from `src/components/Modal.tsx` — portalling,
  backdrop dismissal, and depth-aware Escape (innermost wins). Don't add
  window-level Escape listeners in modal content.
- **Never call `window.prompt`** (or rely on it existing): Electron overrides
  it to throw. Ask for text with `promptText` / show fallback text with
  `presentText` from `src/stores/prompt.ts` (rendered by `PromptHost`).
  ESLint (`no-restricted-syntax`) enforces this in `src/`.
- Model-authored HTML renders **only** inside a sandboxed iframe, served over
  `pidex-artifact://` with its own `default-src 'none'` policy
  (`electron/artifacts/artifact-protocol.ts`). It is deliberately NOT `srcdoc`:
  a srcdoc document inherits the app's CSP, which refused every inline script
  and made `sandbox="allow-scripts"` a no-op. Two things must never change —
  the iframe must never gain `allow-same-origin` (it is what keeps the origin
  opaque), and the served policy must never gain a `connect-src` (it is what
  denies the document any network reach). Widen neither.
- Renderer path aliases: `@/` → `src/`, `@shared/` → `shared/`.
- Browser-only dev (vite without Electron) auto-installs
  `src/dev/mockPidex.ts` when `window.pidex` is undefined — new IPC channels
  used by screens the harness renders need a mock case.
- When you ship a substantial feature or refactor: if it advances a numbered
  phase, add a dated note to that phase's Log in `docs/specs/TRACKER.md`;
  otherwise write it up as its own `docs/log/YYYY-MM-DD-slug.md` (the existing
  files show the convention). Never append a new section to `TRACKER.md` — a
  shared append point is what used to make unrelated PRs conflict. **If the
  change makes a `docs/` file wrong, that file is part of the same diff, not a
  follow-up** — docs drifting from the code is the recurring failure mode here.
  Also update any plan doc you implemented or deviated from.

## Running the app

`npm run dev` requires `pi` on PATH (`npm i -g @earendil-works/pi-coding-agent`,
Node ≥ 22.19). Without it the app boots to the "pi missing" setup screen —
still useful for shell/UI work. For pure renderer work, `npm run dev:web` in
the browser uses the mock API (plain `vite` reads the root `vite.config.ts`,
which mirrors the `renderer` block of `electron.vite.config.ts` — keep the two
in sync). The `/run` and `/e2e` skills cover both flows.

**Never run a packaging build (`electron-builder`, or anything that writes
`release/`) in the main pidex checkout.** It drops a real, fully-formed
`pidex.app` at `~/pidex/release/mac-arm64/pidex.app`, and macOS Spotlight
indexes that identically to the actual install in `/Applications` — same
name, no version shown in search. Launching the wrong one from Spotlight
looks like a broken auto-updater ("Update available" never clears) when it's
actually just a stale local build sitting next to the real app. Confirmed
2026-08-27: a stray `release/` build was 5 versions behind and someone
launched it by mistake straight from search.

The user installs pidex the normal way — download the DMG from
[GitHub Releases](https://github.com/agustinsacco/pidex/releases), drag to
`/Applications`, let it auto-update from there (a release ships on every
green merge to main). If a packaged build is ever genuinely needed for local
testing, point the output outside the repo (e.g. the scratchpad) instead of
letting it land in `~/pidex/release/`.

## Debugging a failing session

`~/Library/Logs/pidex/pidex.log` (Linux: `~/.config/pidex/logs/`) is written by
`electron/debug-log.ts` — always on, no flag, rotating at 5MB. It records pi's
spawn argv, pi's stderr, unexpected exits, and main-process crashes, plus the
inherited `PATH` (a GUI app gets launchd's, not your login shell's, so `pi` and
`claude` can resolve to different binaries than in a terminal).

**Three layers keep evidence, and the useful one is usually the deepest.** An
assistant message with empty content and `totalTokens: 0` in pi's session JSONL
means the model never ran — the provider failed before the API call, so read
the provider's own transcript rather than pidex's error text. For
`pi-claude-cli` that is `~/.claude/projects/<mangled-cwd>/<session-id>.jsonl`,
whose `result` field holds the real API error. Its error template prints
`subtype` while the check that fired is `is_error`, so a genuine failure can
render as the self-contradictory `Error: Claude CLI returned success`.

`cd /tmp && echo hi | pi -p` decides pidex-vs-pi in one command: if it fails
there too, it is not a pidex bug. The `/debug` skill has the full procedure,
including how to shim a nested CLI to capture its real argv.
