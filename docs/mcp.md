# MCP (Model Context Protocol)

pi core deliberately excludes MCP; it arrives via the `pi-mcp-adapter` package
(declared in pi's `settings.json` `packages`). MCP tools reach the chat as
ordinary `tool_execution_*` events, so the transcript needs nothing special.
Phosphor's job is **config management and status surfacing**: mount a server,
sign in, see whether it is up, see what it costs.

## Settings → Connectors

**One tab, one list.** A connector IS an MCP server, and connecting one writes
the `pi-global` scope of the same chain a custom server lives in, so they share
a list. Sections, in order:

1. **Connected** — one row per resolved server: scope badge, status chip,
   transport, **Test**, Sign in / Reconnect / Connect now (URL servers),
   enable toggle, Edit, Remove. Plus a cached-tool disclosure, shadow notes,
   and a warning when `directTools` is set, since that opts the server out of
   the `mcp` gateway and costs its full schema on every request.
2. **Add a connector** — the curated catalog, minus anything already
   configured.
3. **Advanced** (collapsed) — adapter install state and the chain file list
   with the raw JSON editor. Repair tools, not daily controls.

Eight curated OAuth connectors: Linear, Notion, Braintrust, Datadog, Supabase,
Questrade, Fellow, Slack. Each endpoint is checked against the vendor's docs
_and_ the server's own OAuth metadata, because a wrong URL fails as "broken
auth" (`src/features/connectors/catalog.ts`).

**Add starts the sign-in.** Add writes the `pi-global` entry and immediately
runs the headless OAuth flow, so the row appears in Connected with its flow
card open and the browser already launched. The headless route is used even
when a session is open: that session's adapter read `mcp.json` at startup and
has never heard of the server just written.

**Two connectors default to read-only, on purpose.** With no `oauth.scope`
configured the MCP SDK requests every scope the server advertises, and for a
brokerage that includes placing orders. Questrade pins its read scopes
(`QUESTRADE_READ_SCOPES`; the write scopes are named so a test can assert they
never leak). Supabase's knob is a query parameter, so its `read_only=true`
endpoint is the default; that constrains the SQL user, not the OAuth grant,
and without `?project_ref=<ref>` the server reaches every project in the
account.

**"Is it up?" is a button, not an inference.** The status chip comes from the
adapter inside a live session, so with nothing open a row can only say
`state unknown`. **Test** runs the adapter's own `/mcp reconnect <server>` in
a throwaway `pi --mode rpc --no-session` (`electron/pi/connector-check.ts`),
which closes the connection, opens a fresh one, and reports the outcome.
`parseReconnectNotice` (`shared/connectors.ts`) turns that into a verdict:
`Up · N tools`, `Needs sign-in`, `Down`, `Disabled`, `Not in config`. It fails
closed: anything unrecognised or timed out is `Test inconclusive`, never a
wrong up-or-down. No model runs, so a test spends no tokens.

Three rules hold this together:

1. **Phosphor never holds a connector token.** The adapter does PKCE, dynamic
   client registration, a loopback callback on `localhost:19876/callback` and
   token custody in the OS credential store. Phosphor writes `mcp.json` and
   nothing else. Two copies of a refresh token means one is always stale.
2. **Auth is actuated by the adapter's own command,** `/mcp-auth <server>`. pi
   runs extension commands without an LLM call, so connecting spends **no
   tokens**. Disconnect is `/mcp logout`, reconnect `/mcp reconnect`. Two
   routes to that command:
   - **Headless** (`mcp:authorize`, the default): main spawns a throwaway
     `pi --mode rpc --no-session` (`electron/pi/connector-auth.ts`), drives the
     flow, opens the browser, and kills the process when it settles. No
     session file appears, nothing lands in the registry. This is what makes
     Settings usable on a fresh launch.
   - **In-session**: the adapter auto-authenticates mid-turn when a model calls
     a tool whose server has no token, so the same prompt can arrive on a live
     session's extension-UI channel. It routes to the same store and card.
3. **Phosphor never auto-answers the adapter's authorization prompt.** The
   adapter asks for the callback URL through `ctx.ui.input`; Phosphor claims
   that request, opens the browser, shows a card, and then waits, possibly
   forever.

   This is a **permanent constraint**, and the reason is upstream: pi's RPC
   has **no server→client cancel**. When the loopback callback wins the race,
   the adapter abandons its prompt silently, and nothing distinguishes that
   from a prompt still waiting. Answering empty or cancelling to "clean up"
   loses the race the other way and throws `OAuth authentication cancelled`
   on a sign-in that already succeeded. So a pending request stays pending,
   and only an explicit user Cancel ever answers it. No timeout, no sweep, no
   "the flow settled" heuristic. The interception is global, not scoped to
   Settings, because of the in-session route above.

Slack is the one connector that cannot be one click, and its row says why.
Slack supports neither SSE nor Dynamic Client Registration, and its
authorization server has no `registration_endpoint`, so MCP clients must be
backed by a registered Slack app with a fixed app id. You register an app and
paste its **client id**; Add stays disabled until you do. Slack also refuses a
`http://localhost` redirect unless the app has **PKCE** enabled, and a PKCE app
is a public client, so the secret is optional and an empty one is never
written. The redirect URI pins the callback port (default `19876`,
`MCP_OAUTH_CALLBACK_PORT` overrides). Only internal or Marketplace-published
apps may use MCP, and the app's declared user scopes must cover what Phosphor
asks for; the row's "Set up the app" disclosure hands over an app manifest
that sets scopes, redirect URL and `pkce_enabled` in one paste, and the catalog
writes `oauth.scope` from the same list.

## The Claude provider reaches MCP through pi, not around it

A `pi-claude-cli` session has **two** possible sources of MCP servers, and
only one of them is Phosphor's.

1. **pi's chain** (table below), loaded by the adapter, which registers `mcp`
   / `mcpScript` into pi's tool registry. pi-claude-cli snapshots every
   non-built-in pi tool into a schema-only MCP server it hands the CLI as
   `--mcp-config`, so the gateway arrives as `mcp__custom-tools__mcp`. The
   schema server proxies `tools/call` back to pi; pi runs the real tool and
   returns the result to the same persistent CLI process.
2. **The Claude CLI's own chain**: `~/.claude/.mcp.json`, `~/.claude.json`,
   and claude.ai account connectors. Phosphor neither reads nor writes these.

Servers from (2) are a problem, not a bonus: they never become pi tool events,
so `worktree-paths.ts` cannot guard them, the footer chip and the context
meter cannot see them, and the same project behaves differently on two
machines. So every Claude-provider spawn gets `PI_CLAUDE_CLI_STRICT_MCP=1`
(`claudeProviderSpawnEnv` in `electron/pi/provider-detect.ts`), which passes
`--strict-mcp-config` and drops chain (2) entirely.

Every live spawn also receives `PI_CLAUDE_CLI_TOOL_RESULTS=1`, which is what
lets a CLI-side tool row show an outcome: the provider tags each call marker
with its `tool_use_id` and follows it with a `result` marker, so the transcript
can say "419 lines" or "exit 1 · No such file" instead of only naming the tool
([extensions.md](extensions.md#how-provider-transcripts-render)). The metrics
behind those lines need provider ≥ 0.8.0; below it the flag still yields a
status and an expandable preview.

Every live spawn also receives `PI_CLAUDE_CLI_CONTEXT=pi`, native-provider
sessions included so a later switch to Claude is consistent. pi keeps its
project-context loading; the provider suppresses Claude's second memory and
skill loader, aligns generated tool guidance, and disables claude.ai
connectors. Claude's default prompt and native tools remain, as do explicit
host guards and administrator policy.

**Requires an installed pi-claude-cli ≥ 0.7.1.** Phosphor checks declared
global and project provider packages before creating a Claude session or
forwarding a switch to Claude. Old, missing or mixed packages produce an update
message rather than silently ignoring the policy. Nothing is installed or
upgraded for you. Start fresh sessions when adopting the policy; the provider
refuses saved prompts from the previous one. 0.7.1 in turn needs Claude Code
**2.1.263+**.

The gateway is also what keeps a session small: `mcp` + `mcpScript` cost
~3.9KB of schema no matter how many servers are configured, growing only by
the server names in the `mcp` description. `directTools` opts a server out:
its tools become flat top-level names, worth ~80KB of schema for a server like
Linear.

## Per-server status

`pi-ext/mcp-status.ts` forwards the adapter's `pi-mcp-adapter/status/v1`
snapshots to the renderer under status key `phosphor-mcp-status` (lowercase, a
string literal matched on both sides with no type to catch a mismatch). That is
the only structured source of per-server state: connected / needs-auth /
failed / cached / disabled / not-connected, plus tool and resource counts. It
needs a live session, since the adapter runs inside one; with none, a row reads
"state unknown" rather than inventing one. Signing in does **not** need a
session; only observing state does.

The session footer renders it as a chip (`MCP 2/3 · 48 tools`) that opens
Settings → Connectors; the context meter attributes MCP schema cost per server.

## Config chain (adapter-documented, lowest → highest)

| Scope        | File                                                               |
| ------------ | ------------------------------------------------------------------ |
| `xdg`        | `$XDG_CONFIG_HOME/mcp/mcp.json` (default `~/.config/mcp/mcp.json`) |
| `agents`     | `~/.agents/mcp.json`                                               |
| `agents-dir` | `~/.agents/mcp/mcp.json`                                           |
| `pi-global`  | `~/.pi/agent/mcp.json` (honors `PI_CODING_AGENT_DIR`)              |
| `project`    | `<workspace>/.mcp.json`                                            |
| `pi-project` | `<workspace>/.pi/mcp.json`                                         |

Shape: `{"mcpServers": {name: {url | command+args+env, directTools?, disabled?}}}`.
Later files win per server name; Phosphor records shadowed scopes.

## Rules

- **Renderer sends scope enums, never paths.** Path resolution lives in
  `electron/pi/mcp-config.ts` only. New servers are written to `pi-global` /
  `pi-project`; disable/remove target the server's own file.
- Malformed files are surfaced, never overwritten by structured writes. The raw
  JSON editor covers repair and validates on save.
- Structured mutations preserve unknown keys.
- Exactly one of `url` / `command` per server; names refuse path separators.

## Status honesty

There is no structured per-server liveness source **other than the status
extension above**, and that requires a live session. Without one the tab shows:

1. **Installed** — from `packages:list` (per scope). One-click install runs
   pi's own package manager, streamed, with a "restart sessions to apply" note.
   Full package management: [extensions.md](extensions.md).
2. **Session line** — the adapter's `setStatus` footer text for the active
   session, ANSI-cleaned, labelled as adapter-reported.
3. **Cached tools** — `~/.pi/agent/mcp-cache.json`, parsed tolerantly,
   labelled "cached".

## Code map

- Types: `shared/mcp.ts`. Main: `electron/pi/mcp-config.ts` (injectable dirs
  for hermetic tests).
- IPC: `mcp:readConfigs / upsertServer / removeServer / setDisabled /
readCache / readFile / writeFile`, plus `mcp:authorize /
mcp:submitAuthCallback / mcp:cancelAuth / mcp:checkServer` and the
  `mcp:authState` broadcast (`electron/ipc/mcp-handlers.ts`). The in-session
  route adds no IPC; it drives pi over `piCommand` and `app:openExternal`.
- Connectors: `shared/connectors.ts` (prompt/verdict parsers, shared by main
  and renderer), `src/features/connectors/` (`catalog.ts`, `mcpStatus.ts`,
  `FlowCard.tsx`, `ServerEditor.tsx`), `src/stores/connectors.ts`,
  `electron/pi/connector-auth.ts`, `electron/pi/connector-check.ts`,
  `pi-ext/mcp-status.ts`.
- UI: `src/features/settings/tabs/ConnectorsTab.tsx`. Mock cases in
  `src/dev/mockPhosphor.ts`.
