# AGENTS.md

Instructions for coding agents in this repository. `CLAUDE.md` only imports this
file, so edit this one. Keep it short: detail belongs in the linked doc.

Phosphor is an Electron desktop app that wraps the **pi coding agent**
(`@earendil-works/pi-coding-agent`): one `pi --mode rpc` subprocess per live
session, spoken to over JSONL on stdio. Phosphor never imports pi's code; the
protocol is hand-mirrored in `libs/shared/src/rpc.ts`. The same client UI also
runs as a PWA (`apps/web`) against the Host CLI (`apps/host`).

**Maps.** [README.md](README.md#repo-layout) has the repo tree, the only copy.
[docs/README.md](docs/README.md) indexes the docs. Everything in `docs/` is present
tense: how Phosphor behaves **now**, one living contract per surface. Two
exceptions: [known-issues.md](docs/known-issues.md) holds defects that reproduce
today, and [future-features.md](docs/future-features.md) holds directions that are
not built. A feature moves into its surface's living doc and leaves that file in
the same diff that builds it. [remediation.md](docs/remediation.md) tracks the
engineering remediation and what is left of it.

## Commands

```bash
npm run dev          # Electron + Vite with HMR (needs pi on PATH)
npm run dev:web      # the renderer in a browser, against the mock API
npm run typecheck    # all-file audit + Desktop/tests, libraries, Host, Control, tooling, site
npm run lint         # eslint + typed oxlint (suppression ratchets) + the dead-mock check
npm run format       # prettier --write
npm test             # vitest unit tests
npm run test:e2e     # builds, then Playwright-Electron against the pi stub
npm run test:e2e:web # the PWA in Chromium and WebKit
npm run validate     # all of the above, quiet: PASS/FAIL summary + a log file
```

Install with `npm ci` and `npm ci --prefix apps/site`. [Testing](docs/testing.md)
owns the commands, frozen-test rules, coverage evidence, size budgets and lint
ratchets. CI runs typecheck, lint, `prettier --check .`, unit tests, the size
ratchet, builds and both e2e suites. Run typecheck + lint + test before calling a
change done. Run Desktop e2e when touching IPC, session lifecycle or a visible UI
flow, and web e2e when touching `libs/client-ui` or `libs/host-client`.
`SKIP_E2E=1 npm run validate` stops before the slow part. E2E windows never
appear on your screen.

## Architecture in six facts

1. **Desktop's main process owns its side effects.** The renderer is sandboxed
   (contextIsolation, no Node) and is pure UI over typed IPC. Disk, network and
   subprocess work goes in `apps/desktop/electron/`.
2. **IPC is a typed contract.** A new channel is an entry in its prefix's map under
   `libs/shared/src/ipc/`, a handler in `apps/desktop/electron/ipc/<prefix>-handlers.ts`,
   and a case in `libs/client-ui/src/dev/mockPhosphor.ts` if the browser harness
   uses it. `apps/desktop/electron/ipc.ts` is only the composition root; the
   session registry is `apps/desktop/electron/registry.ts`.
3. **RPC to pi goes through `libs/client-ui/src/lib/rpc.ts`** (`piCall` / `piCallOk`),
   which unwraps the `{success, data?, error?}` envelope and surfaces failures on
   the session's chat. Lint rejects a raw `window.phosphor.piCommand`.
4. **`libs/shared/src/rpc.ts` mirrors pi's protocol** with compile-time drift
   guards (`_NoMissingResponseKeys` / `_NoExtraResponseKeys`): a new RPC command
   updates the command union and `RpcResponseDataMap`, or it won't compile.
5. **Every session is independent.** No cross-session manager, no fleet hub, no
   orchestrator, no reclamation of idle subprocesses. That layer was removed on
   2026-09-03 for maintenance cost; do not grow it back (cost:
   [known-issues.md](docs/known-issues.md) S11). Routines run their own sessions
   through main's runtime ([routines.md](docs/routines.md)). The session service in
   `libs/session-runtime/src/pi/` owns startup, admission, per-owner path locks
   and deletion; Desktop (`apps/desktop/electron/pi/session-runtime.ts`) and the
   Host (`apps/host/src/session/runtime.ts`) bind it. New callers use the service
   and its lock domain, never low-level spawn. The locks are process-local. The
   Host ([host.md](docs/host.md)) listens on 127.0.0.1 only, for grant-authenticated
   clients, and builds pi's environment from its own config, never from a caller.
   `apps/control` holds identity and machine metadata, never lane contents, paths
   or private keys ([remote-access.md](docs/remote-access.md)).
6. **Stores (`libs/client-ui/src/stores/`, zustand) project main-process state.**
   `files.ts` and `terminal.ts` are keyed `byWorkspace[path]`; their selectors
   return a shared frozen empty value, so never mutate it or inline a fresh `{}`.
   The current workspace is `useActiveWorkspace()`, not a global.

## Engineering rules

From the 2026 engineering review. The first three are enforced by CI; the rest
are on the author and the reviewer.

- **Size.** Source files ≤ 400 lines, functions ≤ 80, test files ≤ 800.
  `tools/scripts/size-budget.mjs` gives old offenders one-way ceilings and fails
  new ones. Split by responsibility, not to dodge the count.
- **No unhandled promises.** `no-floating-promises` and `no-misused-promises` are
  errors wherever a TS project owns the file. Await it, return it, or `.catch` it
  into a visible failure; `void` only when the callee handles its own errors.
  `oxlint-suppressions.json` records older violations and only shrinks, as
  `eslint-suppressions.json` does for the other rules: never add to either to
  land a change.
- **No dead mocks.** `npm run lint` fails on a `vi.mock` of a module the test never
  loads. Moving or renaming a module means retargeting its mocks.
- **One home per helper.** Search before writing one. Path checks, process-tree
  kills, print-mode runners and fake hosts were each copied two to four times and
  drifted apart. Shared code lives in a `libs/*` package, imported through its
  `@phosphor/<lib>/…` subpath (lint and boundary tests enforce this).
- **Pin behaviour before changing it.** A refactor starts with a characterization
  test that passes on the old code; a fix starts with a regression test that fails
  on it, committed first ([testing.md](docs/testing.md#characterization-and-freeze-rules)).
- **Contracts change deliberately.** IPC maps, the Host protocol, the control API
  and extension status keys have freeze tests. Change both ends in one diff.
- **A screen that loads data must recover.** Load only once what it needs is
  ready (for example, its lane is active), and load again when that changes. One
  failed load must not leave a permanent error; test the failing first attempt.
- **Shared UI runs in two shells.** `libs/client-ui` talks only to
  `window.phosphor`, which Electron's preload and the PWA's Host bridge both
  provide. No Electron or Node imports there.
- **Main stays green.** If main is red, fix it in its own PR first. Never merge on
  a red or skipped check.

## Sharp edges

Read the linked doc before touching any of these.

- Pi session files are edited only through `apps/desktop/electron/pi/session-mutation.ts`,
  inside the path lock resume and deletion share; never call `session-writer.ts`
  directly ([pi-integration.md](docs/pi-integration.md#sessions-on-disk-drives-the-sidebar-without-spawning-processes)).
- JSONL framing is strict LF through `JsonlDecoder`, never `readline`, which splits
  on U+2028/U+2029 inside JSON strings.
- `libs/session-runtime/src/pi/pi-paths.ts` is the only source of pi's session
  layout and cwd mangling; `apps/desktop/e2e/fixtures/pi-stub.cjs` copies the
  mangling, so keep them in sync.
- `pi -p` waits for stdin EOF: never run it through `execFile`/`exec`, spawn it
  through `print-mode.ts` ([pi-integration.md](docs/pi-integration.md#process-model)).
- A live session's title comes from the chat store's `meta.sessionName`, because
  pi writes the file late and the scan lags (same doc, Sessions on disk).
- `apps/desktop/electron/store.ts` builds its electron-store lazily, so E2E can
  redirect `userData` first.
- E2E env hooks (`PHOSPHOR_PI_STUB`, `PHOSPHOR_E2E_WORKSPACE`,
  `PHOSPHOR_TEST_USER_DATA`) stay gated on `!app.isPackaged`. Ungated, they are
  env-triggered code execution in a shipped app.
- `bootstrapSession` learns the session path asynchronously, so last-session
  persistence lives in two places in `stores/sessions.ts`. Read its comments
  before simplifying.
- Session-dir watchers follow sidebar group visibility. No unbounded watch paths.
- Old Claude Code transcripts hold marker blocks pi never emits. Read
  [extensions.md](docs/extensions.md#how-provider-transcripts-render) before
  touching transcript rendering, tool UX or sub-agent UI.
- Claude is a separately versioned pi provider (`pi-claude-cli >= 0.10.0`); pi owns
  its prompt, tools, compaction and thinking. No per-provider compaction toggles.
  Read [cli-providers.md](docs/cli-providers.md) and
  [provider-symmetry.md](docs/provider-symmetry.md) before changing either side.
- Every interactive session shares one provider-blind context budget
  (`sessionContextBudget`, default 200k); in-run cap changes wait for `turn_end`
  ([cli-providers.md](docs/cli-providers.md#one-context-budget)).
- Six bundled extensions run inside pi. `worktree-paths.ts` refuses tool calls that
  escape a worktree; its four conditions are narrow on purpose. `tool-name-guard.ts`
  rewrites malformed tool names before pi persists them
  ([extensions.md](docs/extensions.md)).
- Status keys (`phosphor-*`, `claude-*`) and widget payloads are unchecked wire
  contracts ([extensions.md](docs/extensions.md#the-status-channel-is-a-wire-contract)).
  Sub-agents are pi-subagents on both providers ([chat.md](docs/chat.md#sub-agents)).
- macOS updates by swapping its own bundle beside the installed `.app`
  ([updates.md](docs/updates.md)).
- MCP credentials belong to pi. Phosphor never holds a token or answers a dialog
  ([mcp.md](docs/mcp.md#settings--connectors)).

## Conventions

- Tests live beside their subject as `*.test.ts` until RL-03 moves them to `test/`
  folders; shared inputs go in sibling `__fixtures__/`. DOM suites opt in with
  `// @vitest-environment jsdom`. Prefer testing pure logic over components. See
  [Testing](docs/testing.md#layout-and-helpers).
- Modals use `ModalOverlay` (`libs/client-ui/src/components/Modal.tsx`), which owns
  depth-aware Escape. No window-level Escape listeners in modal content.
- Never call `window.prompt`: Electron makes it throw. Use `promptText` /
  `presentText` from `libs/client-ui/src/stores/prompt.ts` (lint enforces it).
- Model-authored HTML renders only in a sandboxed iframe over
  `phosphor-artifact://` (`artifact-protocol.ts`), never `srcdoc`. The iframe never
  gains `allow-same-origin` and the policy never gains a `connect-src`.
- `phosphor-file://` (`fs/file-protocol.ts`) serves only what `grantPreview`
  granted by token, never a path from the URL. New schemes join the single
  `protocol.registerSchemesAsPrivileged` call in `main.ts`; a second call is dropped.
- Aliases: `@/` is `libs/client-ui/src/`, `@phosphor/shared/` is `libs/shared/src/`
  (`@shared/` is a legacy alias for it).
- No dated write-ups: git is the history and the commit message holds the
  reasoning. If a change makes a `docs/` file wrong, that file is in the same diff.
  Fixing a [known issue](docs/known-issues.md) deletes its row in the same diff.

## Running the app

`npm run dev` needs `pi` on PATH (`npm i -g @earendil-works/pi-coding-agent`,
Node ≥ 22.19); without it the app boots to the setup screen. `apps/desktop/vite.config.ts`
mirrors the `renderer` block of `apps/desktop/electron.vite.config.ts`; keep them in
sync. The `/run` and `/e2e` skills cover both flows. Never run a packaging build
in the main checkout ([desktop-build.md](docs/desktop-build.md#never-package-in-the-main-checkout)).

## Debugging a failing session

`~/Library/Logs/Phosphor/phosphor.log` (Linux: `~/.config/Phosphor/logs/`) records
pi's spawn argv, stderr, unexpected exits, crashes and the inherited `PATH`. An
assistant message with empty content and `totalTokens: 0` means the provider failed
before the model ran: read the provider's own transcript (for `pi-claude-cli`,
`~/.claude/projects/<mangled-cwd>/<session-id>.jsonl`, field `result`). If
`cd /tmp && echo hi | pi -p` fails too, it is not a Phosphor bug. The `/debug` skill
has the full procedure.
