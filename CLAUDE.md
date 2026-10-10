# CLAUDE.md

Phosphor is an Electron desktop app that wraps the **pi coding agent**
(`@earendil-works/pi-coding-agent`) — one `pi --mode rpc` subprocess per live
session, spoken to over JSONL on stdio. Phosphor never imports pi's code; the
protocol is hand-mirrored in `libs/shared/src/rpc.ts`.

**Two maps before you start.** [README.md](README.md#repo-layout) has the repo
tree — the single copy, since three copies drifted.
[docs/README.md](docs/README.md) is the documentation index. Everything in
`docs/` is present tense: how Phosphor behaves **now**, one living contract per
surface. The single exception is
[docs/known-issues.md](docs/known-issues.md), which is defects that reproduce
today. There is no history folder and no specs folder — git is the history, and
a doc is updated in the same diff as the behaviour it describes.

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

`npm run validate` (`tools/scripts/validate.sh`) is the one to reach for when you
just want a verdict: it prints one line per step and sends everything else to
`$VALIDATE_LOG` (default `/tmp/phosphor-validate-$$.log`). `SKIP_E2E=1` stops
before the slow part.

**E2E windows never appear on your screen**, so a background agent running the
suite can't steal focus mid-keystroke. `tools/scripts/e2e.sh` prefers `xvfb-run`
(real windows on a virtual display, full speed — install with
`sudo apt install xvfb`) and otherwise leaves the windows unmapped
(`hideWindowsForE2E` in `apps/desktop/electron/window-chrome.ts`), which is ~2-3x slower
because Chromium deprioritizes rendering for a window that was never shown.
`PHOSPHOR_E2E_SHOW=1 npm run test:e2e` puts them back on your real display when
you want to watch.

## Architecture in six facts

1. **The main process owns all side effects.** The renderer runs sandboxed
   (contextIsolation, no Node) and is pure UI over typed IPC. If a feature
   needs disk/network/subprocess, it goes in `apps/desktop/electron/`, not `apps/desktop/src/`.
2. **IPC is a typed contract.** A new channel = an entry in
   `libs/shared/src/ipc.ts` `IpcInvokeMap` + a handler in
   `apps/desktop/electron/ipc/<prefix>-handlers.ts` (the module matching the channel prefix
   — 19 of them, listed in [README.md](README.md#repo-layout)) + a case in
   `apps/desktop/src/dev/mockPhosphor.ts` if the browser harness should exercise it.
   `apps/desktop/electron/ipc.ts` is only the composition root; the session registry lives
   in `apps/desktop/electron/registry.ts` so handlers never import their composition root.
3. **RPC to pi goes through `apps/desktop/src/lib/rpc.ts`** (`piCall` / `piCallOk`), which
   unwraps the `{success, data?, error?}` envelope and surfaces failures on
   the session's chat. Calling `window.phosphor.piCommand` directly means you own
   the error branch — half the original call sites forgot, so don't.
4. **`libs/shared/src/rpc.ts` is a mirror of pi's protocol** with compile-time drift
   guards (`_NoMissingResponseKeys` / `_NoExtraResponseKeys`). Adding an RPC
   command means updating both the command union and `RpcResponseDataMap`, or
   it won't compile — that's intentional.
5. **Every session is independent.** There is no cross-session manager: no
   fleet hub, no orchestrator thread, no automatic reclamation of an idle
   session's subprocess. Interactive sessions are created from the renderer;
   explicit local routines also start sessions through main's shared runtime
   ([routines.md](docs/routines.md)). Their bounded scheduler owns only those
   executions, not an agent fleet. `apps/desktop/electron/registry.ts` remains the only
   live-process registry. The
   orchestration layer that used to do this was removed on 2026-09-03 for
   maintenance cost — it touched session spawn, IPC, the sidebar, the home
   screen and settings at once. Do not grow it back. The known cost of the
   removal is that nothing reclaims an idle session's ~172 MB pi tree
   ([known-issues.md](docs/known-issues.md) S11).
   The portable session service lives in `libs/session-runtime/src/pi/`: policy/startup,
   command/resume admission, per-owner path locks and deletion coordination.
   `apps/desktop/electron/pi/session-runtime.ts` binds Desktop's machine and delivery ports;
   IPC handlers delegate to it. New callers must use the service and share one
   path-lock domain with deletion, not call low-level spawn to bypass admission.
   These locks are process-local, not remote authorization or cross-process locks.
   `apps/host` ([host.md](docs/host.md)) is the plain-Node Host CLI. It checks a
   machine (`doctor`) and proves it with real sessions (`accept`), which run on
   `apps/host/src/session/runtime.ts`: the same service and deletion over one
   lock domain. Nothing reaches it over a network yet. It builds
   pi's environment from its own config and never takes environment, executable
   or extension paths from a caller.
6. **Stores (`apps/desktop/src/stores/`, zustand) are projections of main-process state.**
   `files.ts` and `terminal.ts` are keyed `byWorkspace[path]`; their
   `workspaceFiles()` / `workspaceTerminals()` selectors return a shared
   frozen empty value — never mutate it, never inline a fresh `{}` in a
   selector. "Which workspace am I in?" is `useActiveWorkspace()` (derived,
   prefers the active session's own cwd) — not a global current-workspace.

## Sharp edges (read before touching)

- **`apps/desktop/electron/pi/session-writer.ts` appends to pi's own session files**
  (bookmarks, branch jumps, forks). It is only safe while no pi process owns
  the file — call sites enforce this by convention. It depends on pi's on-disk
  format staying stable. Tests: `apps/desktop/electron/pi/session-writer.test.ts`.
- **JSONL framing is strict LF via `JsonlDecoder`, never `readline`** —
  U+2028/U+2029 are legal inside JSON strings and readline splits on them.
- **`libs/session-runtime/src/pi/pi-paths.ts` is the single source of truth** (re-exported from
  `apps/desktop/electron/pi/pi-paths.ts`) for pi's session directory layout and cwd mangling (`realpathSync.native` first — pi resolves
  symlinks). The e2e stub duplicates the mangling in
  `apps/desktop/e2e/fixtures/pi-stub.cjs`; keep them in sync.
- **`pi -p` blocks until stdin reaches EOF, so it must never be run through
  `execFile`/`exec`.** Both leave the child's stdin an open pipe, and pi then
  sits there until the caller's timeout — silently, with empty stdout and empty
  stderr. That killed session auto-naming outright for weeks: no session was
  ever named and no branch was ever renamed. Spawn print-mode runs through
  `apps/desktop/electron/pi/print-mode.ts` (`stdio[0] = 'ignore'`). The e2e stub cannot
  catch a regression — it prints and exits without reading stdin — so the guard
  is `apps/desktop/electron/pi/print-mode.test.ts`.
- **pi writes a session's file only when a turn ENDS**, not incrementally. A
  name set mid-turn does not reach the disk scan until the reply lands, so
  every surface showing a LIVE session's title prefers the chat store's
  `meta.sessionName` over the scanned `meta.name`, and a session keeps its
  placeholder sidebar row (`PendingSessionRow`) for the whole first turn.
- **`apps/desktop/electron/store.ts` constructs its electron-store lazily on purpose** —
  a module-scope `new Store()` would resolve `userData` before main.ts can
  redirect it for E2E, leaking test state into real prefs.
- **E2E env hooks (`PHOSPHOR_PI_STUB`, `PHOSPHOR_E2E_WORKSPACE`,
  `PHOSPHOR_TEST_USER_DATA`) must stay gated on `!app.isPackaged`.** Ungated,
  they are env-var-triggered code execution in the main process of a shipped
  app (fixed once; don't regress it).
- **`bootstrapSession` learns a session's file path asynchronously** (from
  `get_state`), so last-session persistence happens in two places in
  `apps/desktop/src/stores/sessions.ts` — read the comments there before "simplifying".
- Session-dir watchers are per-workspace chokidar handles tied to sidebar
  group visibility (expanded ⇒ watched, collapsed ⇒ unwatched, all closed on
  quit). Don't add unbounded watch paths.
- **Not every session was produced by a pi-native provider.** Sessions
  recorded on the Claude Code provider (`@saccolabs/pi-claude-cli`) before
  0.9.0 contain block shapes pi itself never emits (current ones do not, but
  old transcripts still open): CLI-side tools arrive as
  `[Claude Code · Name {…}]` marker text blocks (a wire contract —
  `parseExternalToolMarker` turns them into activity steps), their outcomes
  as paired
  `[Claude Code · result #<id> {…}]` markers that fold into the row the call
  already made (never a row of their own), and some models emit thinking with
  a signature and no plaintext. Before touching transcript rendering, tool UX
  or subagent UI, read
  [docs/extensions.md](docs/extensions.md#how-provider-transcripts-render).
- **Claude is a separately versioned provider, not an in-app model client.**
  Phosphor requires `@saccolabs/pi-claude-cli >= 0.10.0`, installed in pi.
  pi owns its prompt, tools, complete results, compaction and thinking level
  (0.9.0 moved the context to pi; 0.10.0 sends the level as pi would and
  applies a change without a restart). The CLI process is a disposable
  cache, retired on switches/context changes; no new Claude
  transcript or pairing is persisted. Native and Claude sessions use the same
  pi compaction setting. Never reintroduce per-provider auto-compaction toggles.
  The package must be published and reinstalled before a source fix is live.
  Every one-shot host passes `claudeOneShotEnv()` to avoid a parked process
  keeping `pi -p` alive after its answer. Existing Claude marker transcripts
  remain supported. See [cli-providers.md](docs/cli-providers.md). A Claude
  session is meant to match a native one: before changing the prompt, tools,
  compaction or thinking on either side, read
  [provider-symmetry.md](docs/provider-symmetry.md) and re-run its checks.

- **Interactive sessions share an absolute context budget (default 200k),
  Claude included.** `libs/shared/src/context-budget.ts` (`sessionContextBudget`) is
  the rule, and it never looks at the provider; the pref is
  `AppPrefs.contextBudget` (Settings → Agent → Context budget). pi's catalogue
  gives most Claude models a 1M window, so pi's own threshold
  (`contextWindow - reserveTokens`) alone lets such a session reach ~984k
  before it compacts. The bundled context extension loads
  `libs/pi-extensions/pi-ext/context-budget.ts` to cap session-local model metadata via
  `pi.setModel`, without changing the catalogue. pi 0.87.1+ then compacts
  before prompts and between tool cycles, reserving response headroom below
  the budget. In-run cap changes wait for `turn_end`: model-select hooks can
  retire the Claude CLI, so never apply them during a request or tool batch.
  An RPC `compact` aborts a running turn. `apps/desktop/electron/pi/context-budget.ts`
  retains a serialized idle fallback, paused while a routine owns the session;
  native in-loop compaction remains enabled for routines. See
  [cli-providers.md](docs/cli-providers.md#one-context-budget).

- **Phosphor ships six extensions that run inside pi's process** (`libs/pi-extensions/pi-ext/`,
  loaded with `-e` into every session; listed in `bundledExtensions()` in
  `libs/session-runtime/src/bundled-extensions.ts`). They are the only Phosphor code with a
  say inside a turn. The context extension caps the session window for native
  compaction; two others can change or refuse what the model did:
  - **`worktree-paths.ts` can refuse a tool call.** It blocks a
    `read`/`write`/`edit`/`ls`/`grep`/`find` whose path escapes a worktree
    session into the repo's main checkout (a different branch) when the same
    file exists in the worktree —
    models were doing this silently and answering about the wrong branch. The
    four conditions in that file are deliberately narrow; widening them blocks
    legitimate reads, because pi's own prompt sends the model to absolute paths
    outside the cwd for its docs.
  - **`tool-name-guard.ts` rewrites a malformed tool call** at `message_end`,
    before pi persists it. A model can emit a tool call whose _name_ is not a
    tool name (seen: `mcp({})<tool_call>find`, raw syntax leaked into the name
    field). pi tolerates it in the moment and writes it to the session file —
    and then every later turn replays it and the provider rejects the whole
    request (`Member must satisfy regular expression pattern: [a-zA-Z0-9_-]+`),
    bricking the thread permanently. The guard turns it into plain text.
- **Five UI surfaces are fed by extensions, not by RPC.** The context meter's
  composition section comes from `libs/pi-extensions/pi-ext/context-breakdown.ts` (bundled, `-e`
  into every session), per-server MCP state from `libs/pi-extensions/pi-ext/mcp-status.ts`, and
  headroom/compression state from `libs/pi-extensions/pi-ext/headroom.ts`; its plan-limits
  section and the sub-agent chip come from the Claude provider package. All
  arrive over `ctx.ui.setStatus` into `stores/extensionUi.ts`. **The status
  keys are lowercase `phosphor-*` / `claude-*` string literals, unchecked on
  both sides** — a capitalising find-and-replace over the docs silently broke
  them once (fixed 2026-09-09). The two `claude-*` keys cross a repo boundary,
  so nothing here fails to compile when they change; the keys and their rules
  are in
  [docs/extensions.md](docs/extensions.md#the-status-channel-is-a-wire-contract).
  Component sizes in that breakdown are estimates and must stay labelled as
  such — only pi's total is authoritative. Widgets are the same bus:
  pi-subagents publishes its background runs on the `subagent-async` widget
  as one `PI_SUBAGENT_ASYNC_JSON:` line, parsed by `chat/subagentRuns.ts`;
  a widget key with a machine payload must be in `STRUCTURED_WIDGET_KEYS`
  or the composer prints it (it did, for weeks).
- **Sub-agents are pi-subagents on both providers.** Claude Code's own
  `Agent`/`Task` tools are off with the rest of its tools (provider ≥ 0.9.0),
  so the `[Claude Code · Agent …]` markers and the `claude-subagents` key are
  history only. The live path is the `subagent` tool call, its streamed
  `details`, the widget above, and a `subagent-notify` custom message that is
  `display: false` on success and is kept anyway (`CustomItem.quiet`). See
  [docs/chat.md](docs/chat.md#sub-agents).
- **macOS updates itself by replacing its own bundle**, because Squirrel.Mac
  refuses the ad-hoc signature this repo ships (`apps/desktop/electron/updates/mac-installer.ts`).
  Staging lives BESIDE the installed `.app`, not in `/tmp`, so the swap is two
  atomic same-volume renames with a rollback — and the relauncher must poll for
  the old pid to exit, or the single-instance lock in `main.ts` kills the new
  instance and the user is left with no app. The startup sweep that deletes
  leftovers is `rm -rf` next to `/Applications`; its name match is a full-string
  regex on purpose. See [docs/updates.md](docs/updates.md).
- **Connecting an MCP server never puts a token in Phosphor.** The adapter owns
  OAuth and the OS credential store; Phosphor writes `mcp.json` and drives the
  adapter's own `/mcp-auth` command (an extension command, so no model runs).
  And it must **never auto-answer** the adapter's "paste the callback URL"
  prompt: pi's RPC has no dialog cancel, so an empty answer wins the race
  against the loopback callback and kills a flow that already succeeded. See
  [docs/mcp.md](docs/mcp.md#settings--connectors).

## Conventions

- Tests live beside their subject as `*.test.ts` — **everywhere**, `apps/desktop/electron/`
  and `libs/shared/src/` and `libs/pi-extensions/pi-ext/` included. One `__tests__/` directory is left
  (`tools/scripts/__tests__/`); the rest were moved next to their subjects. Shared
  inputs go in a sibling `__fixtures__/`.
  DOM suites opt in per file with `// @vitest-environment jsdom`. Prefer
  testing pure logic extracted into `apps/desktop/src/lib/` / plain modules over component
  tests.
- Modals use `ModalOverlay` from `apps/desktop/src/components/Modal.tsx` — portalling,
  backdrop dismissal, and depth-aware Escape (innermost wins). Don't add
  window-level Escape listeners in modal content.
- **Never call `window.prompt`** (or rely on it existing): Electron overrides
  it to throw. Ask for text with `promptText` / show fallback text with
  `presentText` from `apps/desktop/src/stores/prompt.ts` (rendered by `PromptHost`).
  ESLint (`no-restricted-syntax`) enforces this in `apps/desktop/src/`.
- Model-authored HTML renders **only** inside a sandboxed iframe, served over
  `phosphor-artifact://` with its own `default-src 'none'` policy
  (`apps/desktop/electron/artifacts/artifact-protocol.ts`). It is deliberately NOT `srcdoc`:
  a srcdoc document inherits the app's CSP, which refused every inline script
  and made `sandbox="allow-scripts"` a no-op. Two things must never change —
  the iframe must never gain `allow-same-origin` (it is what keeps the origin
  opaque), and the served policy must never gain a `connect-src` (it is what
  denies the document any network reach). Widen neither.
- Workspace files open in the Files pane's viewers over `phosphor-file://`
  (`apps/desktop/electron/fs/file-protocol.ts`). It serves only what `grantPreview` granted
  by token, never a path named in the URL, and previewed HTML follows the same
  two rules as artifacts. A new scheme goes into the single
  `protocol.registerSchemesAsPrivileged` call in `apps/desktop/electron/main.ts`: Electron
  honours only one call, so a second one silently drops the first.
- Renderer path aliases: `@/` → `apps/desktop/src/`, `@phosphor/shared/` → `libs/shared/src/`.
  `@shared/` remains a compatibility alias to that same source until installation closure.
- Browser-only dev (vite without Electron) auto-installs
  `apps/desktop/src/dev/mockPhosphor.ts` when `window.phosphor` is undefined — new IPC channels
  used by screens the harness renders need a mock case.
- **Do not write a dated write-up for what you shipped.** That convention
  existed until 2026-09-09 and produced 161 files of history that nobody could
  tell apart from living contracts. Git is the history; put the reasoning in
  the commit message. What you owe instead: **if the change makes a `docs/`
  file wrong, that file is part of the same diff, not a follow-up** — docs
  drifting from the code is the recurring failure mode here. And if you fix
  something listed in [docs/known-issues.md](docs/known-issues.md), delete its
  row in the same diff.

## Running the app

`npm run dev` requires `pi` on PATH (`npm i -g @earendil-works/pi-coding-agent`,
Node ≥ 22.19). Without it the app boots to the "pi missing" setup screen —
still useful for shell/UI work. For pure renderer work, `npm run dev:web` in
the browser uses the mock API (plain `vite` reads the `apps/desktop/vite.config.ts`,
which mirrors the `renderer` block of `apps/desktop/electron.vite.config.ts` — keep the two
in sync). The `/run` and `/e2e` skills cover both flows.

**Never run a packaging build (`electron-builder`, or anything that writes
`release/`) in the main Phosphor checkout.** It drops a real, fully-formed
`Phosphor.app` at `~/Phosphor/release/mac-arm64/Phosphor.app`, and macOS Spotlight
indexes that identically to the actual install in `/Applications` — same
name, no version shown in search. Launching the wrong one from Spotlight
looks like a broken auto-updater ("Update available" never clears) when it's
actually just a stale local build sitting next to the real app. Confirmed
2026-08-27: a stray `release/` build was 5 versions behind and someone
launched it by mistake straight from search.

The user installs Phosphor the normal way — download the DMG from
[GitHub Releases](https://github.com/agustinsacco/Phosphor/releases), drag to
`/Applications`, let it auto-update from there (a release ships on every
green merge to main). If a packaged build is ever genuinely needed for local
testing, point the output outside the repo (e.g. the scratchpad) instead of
letting it land in `~/Phosphor/release/`.

## Debugging a failing session

`~/Library/Logs/Phosphor/phosphor.log` (Linux: `~/.config/Phosphor/logs/`) is written by
`apps/desktop/electron/debug-log.ts` — always on, no flag, rotating at 5MB. It records pi's
spawn argv, pi's stderr, unexpected exits, and main-process crashes, plus the
inherited `PATH` (a GUI app gets launchd's, not your login shell's, so `pi` and
`claude` can resolve to different binaries than in a terminal).

**Three layers keep evidence, and the useful one is usually the deepest.** An
assistant message with empty content and `totalTokens: 0` in pi's session JSONL
means the model never ran — the provider failed before the API call, so read
the provider's own transcript rather than Phosphor's error text. For
`pi-claude-cli` that is `~/.claude/projects/<mangled-cwd>/<session-id>.jsonl`,
whose `result` field holds the real API error. Its error template prints
`subtype` while the check that fired is `is_error`, so a genuine failure can
render as the self-contradictory `Error: Claude CLI returned success`.

`cd /tmp && echo hi | pi -p` decides Phosphor-vs-pi in one command: if it fails
there too, it is not a Phosphor bug. The `/debug` skill has the full procedure,
including how to shim a nested CLI to capture its real argv.
