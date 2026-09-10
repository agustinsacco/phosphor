# MCP (Model Context Protocol)

pi core deliberately excludes MCP; it arrives via the `pi-mcp-adapter`
package (declared in pi settings.json `packages`). MCP tools reach the chat
as ordinary `tool_execution_*` events, so the transcript needs nothing
special — Phosphor's job is **config management and status surfacing**.

## Settings → Connectors

**One tab, one list.** Connectors and MCP used to be two tabs, and they were
two views of the same thing: a connector IS an MCP server, and connecting one
writes the `pi-global` scope of the very chain the other tab resolved. The same
rows rendered twice with different affordances, and only the catalog view
carried the adapter's structured per-server state — so the tab that listed
_every_ server was the one that could not say whether any of them worked.

The list is now the resolved chain, enriched with catalog metadata wherever a
server's URL matches a known connector. Sections, in order:

1. **Connected** — one row per resolved server: scope badge, status chip,
   transport, **Test**, Sign in / Reconnect / Connect now (URL servers only),
   enable toggle, Edit, Remove. Plus cached-tool disclosure, shadow notes, and a warning when
   `directTools` is set, since that opts the server out of the `mcp` gateway
   and costs its full schema on every request. Rendered FIRST on purpose.
2. **Add a connector** — the curated catalog, minus anything already
   configured. This is an add affordance, not a separate world.
3. **Advanced** (collapsed) — adapter install state and the chain file list
   with the raw JSON editor. Repair tools, not daily controls.

Eight curated OAuth connectors — Linear, Notion, Braintrust, Datadog,
Supabase, Questrade, Fellow, Slack — each with the endpoint checked against the
vendor's docs _and_ against the server's own OAuth metadata, because a wrong
URL fails as "broken auth" (`src/features/connectors/catalog.ts`; endpoints
and their gotchas are documented per entry there).

**Add starts the sign-in.** Add writes the `pi-global` entry and then
immediately runs the headless OAuth flow, so the row appears in Connected with
its flow card already open and the browser already launched. Add used to only
write `mcp.json`, which left the connector needing a separate Sign in click and
read as "Add did nothing" — worst on Slack, where you have just pasted a client
id and are expecting a browser. The headless route is used even when a session
is open: that session's adapter read `mcp.json` at startup, so it has never
heard of the server just written.

**Two connectors default to read-only, on purpose.** With no `oauth.scope`
configured the MCP SDK requests every scope in the server's
protected-resource metadata, and for a brokerage that set includes
`brokerage.orders.all` — one click would give a model authority to place
trades. Questrade therefore pins `QUESTRADE_READ_SCOPES` (every read scope the
server advertises, no write scope; `QUESTRADE_WRITE_SCOPES` names the excluded
ones so a test can assert they never leak in). Supabase's knob is a query
parameter instead, so its `read_only=true` endpoint is the _first_ variant and
therefore the default; note that this constrains the SQL user, not the OAuth
grant, and that without `?project_ref=<ref>` the server reaches every project
in the account.

**"Is it up?" is a button, not an inference.** The status chip comes from the
adapter inside a live session, so with nothing open the row could only say
`state unknown`, and with a session it said `Signed in · idle` — true, and
silent about whether the server answers right now. **Test** runs the adapter's
own `/mcp reconnect <server>` in a throwaway
`pi --mode rpc --no-session` (`electron/pi/connector-check.ts`, IPC
`mcp:checkServer`), which closes the connection, opens a fresh one, and
reports the outcome as a notify. `shared/connectors.ts`
`parseReconnectNotice` turns that line into a verdict — `Up · N tools`,
`Needs sign-in`, `Down`, `Disabled`, `Not in config` — and the row prefers it
over the status chip, because a fresh reconnect is stronger evidence than the
last snapshot. It fails closed: anything unrecognised, refused or timed out is
`Test inconclusive`, never a wrong up-or-down. No model runs, so a test spends
no tokens.

Three rules hold this together:

1. **Phosphor never holds a connector token.** The adapter does PKCE, dynamic
   client registration, a loopback callback on `localhost:19876/callback` and
   token custody in the OS credential store. Phosphor writes `mcp.json` and
   nothing else. Two copies of a refresh token means one is always stale.
2. **Auth is actuated by the adapter's own command,** `/mcp-auth <server>`. pi
   runs extension commands immediately without an LLM call, so connecting
   spends **no tokens**. Disconnect is `/mcp logout`, reconnect is
   `/mcp reconnect`. Deep-importing the adapter's auth module is not an option:
   only `./oauth` (read tokens) is in its `exports` map, and the package is
   versioned independently of Phosphor.
   There are two routes to that command, and the difference is which process
   runs it:
   - **Headless** (`mcp:authorize`, the default): main spawns a throwaway
     `pi --mode rpc --no-session` (`electron/pi/connector-auth.ts`), drives the
     flow, opens the browser itself, and kills the process when it settles.
     `--no-session` matters twice — no session file appears in the sidebar, and
     the process is never in the registry, so nothing projects it as work. Progress arrives on the `mcp:authState` broadcast. This is what makes
     Settings usable on a fresh launch, which is when people go there.
   - **In-session**: the adapter auto-authenticates mid-turn when a model calls
     a tool whose server has no token, so the same prompt can arrive on a live
     session's extension-UI channel. `stores/extensionUi.ts` routes it to the
     same store and the same card.
3. **Phosphor never auto-answers the adapter's authorization prompt.** The adapter
   asks for the callback URL through `ctx.ui.input`, and Phosphor claims that
   request (`stores/extensionUi.ts` → `stores/connectors.ts`), opens the
   browser and shows a card. Then it waits, possibly forever.

   This is a **permanent constraint, not a rough edge to tidy up later**, and
   the reason is upstream: pi's RPC protocol has **no server→client cancel**.
   An `extension_ui_request` can only be resolved by an answer, so when the
   loopback callback wins the race the adapter abandons its prompt _silently_
   — the request stays open on the wire with nobody left listening. There is
   no signal that distinguishes that state from a prompt still genuinely
   waiting on the user, and there is no message Phosphor can send to retract
   the request. So the tempting cleanup — answering empty, or cancelling, to
   clear a stale-looking prompt — is exactly the bug: it loses the race the
   other way and throws `OAuth authentication cancelled`, killing a sign-in
   that had **already succeeded** seconds earlier.

   Therefore: a pending request is left pending, and only an explicit user
   Cancel ever answers it. No timeout, no cleanup sweep, no "the flow settled
   so we can close this" heuristic. The rule can only be revisited if pi gains
   a server-initiated cancel — until then, an abandoned prompt is the correct
   and harmless outcome. The interception is global, not scoped to Settings,
   because the adapter also auto-authenticates mid-turn when a model calls a
   tool whose server has no token.

Slack is the one connector that cannot be one click, and its row carries the
whole reason why. This is not a Phosphor shortcoming and cannot be designed away:
Slack's docs say "we do not support SSE-based connections or Dynamic Client
Registration at this time" and "MCP clients must be backed by a registered
Slack app with a fixed app ID and hardcode that app ID", and
`mcp.slack.com/.well-known/oauth-authorization-server` carries no
`registration_endpoint` to call even if we wanted to (re-probed 2026-09-07). So
the user registers an app and pastes its **client id**, and the Add button
stays disabled until they do. A one-click Slack row would need Phosphor to own a
Marketplace-published Slack app. Slack also refuses a `http://localhost`
redirect URL unless that app has **PKCE** enabled, and a PKCE app is a _public_
client whose token exchange carries no secret — so the secret field is
optional, and an empty one is never written (the adapter reads any secret as
`client_secret_post`). The registered redirect URI pins the callback port:
default `19876`, `MCP_OAUTH_CALLBACK_PORT` overrides it.

Two more Slack rules the row states, both of which fail late and confusingly:
only **internal or Marketplace-published** apps may use MCP at all, and the
app's declared user scopes must cover what Phosphor asks for. The row's "Set up
the app" disclosure hands over an app manifest that sets the scopes, the
redirect URL and `pkce_enabled` in one paste, and the catalog writes
`oauth.scope` from the same list (`SLACK_USER_SCOPES`) — with no scope
configured the MCP SDK asks for every scope in the server's
protected-resource metadata, and Slack fails the whole authorization for any
scope the app does not declare.

## The Claude provider reaches MCP through pi, not around it

A `pi-claude-cli` session has **two** possible sources of MCP servers, and only
one of them is Phosphor's.

1. **pi's chain** (the table below), loaded by the adapter, which registers
   `mcp` / `mcpScript` into pi's tool registry. pi-claude-cli then snapshots
   every non-built-in pi tool into a schema-only MCP server it hands the CLI as
   `--mcp-config`, so the gateway arrives as `mcp__custom-tools__mcp`. The
   schema server proxies `tools/call` back to pi. pi executes the real tool
   and returns its result to the same persistent CLI process.
2. **The Claude CLI's own chain** — `~/.claude/.mcp.json`, `~/.claude.json`,
   and the user's claude.ai account connectors. Phosphor neither writes nor reads
   these.

Servers from (2) are a problem, not a bonus. They never become pi
`tool_execution_*` events (only `mcp__custom-tools__*` does), so
`worktree-paths.ts` cannot guard them; the footer chip and the context meter
both read the adapter, which knows nothing about them; and the same project
behaves differently on two machines. So every Claude-provider spawn gets
`PI_CLAUDE_CLI_STRICT_MCP=1` (`claudeProviderSpawnEnv` in
`electron/pi/provider-detect.ts`), which passes the CLI `--strict-mcp-config`
and drops chain (2) entirely.

Every live pi spawn also receives `PI_CLAUDE_CLI_TOOL_RESULTS=1`, which is
what lets a CLI-side tool row show an outcome at all: the provider then tags
each call marker with its `tool_use_id` and follows it with a `result`
marker, so the transcript can say "419 lines" or "exit 1 · No such file"
instead of only naming the tool
([extensions.md](extensions.md#how-provider-transcripts-render)). The metrics
behind those lines need provider >= 0.8.0; below it the flag still yields a
status and an expandable preview.

Every live pi spawn also receives `PI_CLAUDE_CLI_CONTEXT=pi`, including native
provider sessions so a later switch to Claude is consistent. pi retains its
project-context loading; the provider suppresses Claude's second memory and
skill loader, aligns generated tool guidance, and disables claude.ai connectors.
Claude's default prompt and native tools remain. Explicit host guard settings
and administrator-managed policy remain honored.

**Requires an installed pi-claude-cli >= 0.7.1.** Phosphor checks declared global
and project provider packages before creating a Claude session or forwarding a
switch to Claude. Old, missing, unversioned, or mixed unsupported packages
produce an update message rather than silently ignoring the policy. No package
is automatically installed or upgraded. Start fresh sessions when adopting the
policy; the provider refuses to reuse saved prompts from the previous policy.
0.7.1 in turn needs Claude Code **2.1.263+**, the first release with the
isolation controls the profile is built on.

The gateway is also what keeps a session small: `mcp` + `mcpScript` cost ~3.9KB
of schema no matter how many servers are configured, growing only by the server
names listed in the `mcp` description. `directTools` on a server entry opts out
of that — it promotes that server's tools to flat top-level names, which is
worth ~80KB of schema for a server like Linear.

## Per-server status

`pi-ext/mcp-status.ts` forwards the adapter's `pi-mcp-adapter/status/v1`
snapshots to the renderer under status key `phosphor-mcp-status` — lowercase,
a string literal matched on both sides with no type to catch a mismatch
(`MCP_STATUS_STATUS_KEY` in `src/features/connectors/mcpStatus.ts`). That is the only structured source of
per-server state: connected / needs-auth / failed / cached / disabled /
not-connected, plus tool and resource counts. It needs a live session, since
the adapter runs inside one — with no session a connector row reads
“state unknown” rather than inventing one. Signing in does **not** need a
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

- **Renderer sends scope enums, never paths** — path resolution lives in
  `electron/pi/mcp-config.ts` only. Writes are limited to `pi-global` /
  `pi-project` for new servers; disable/remove target the server's own file.
- Malformed files are surfaced (never overwritten by structured writes); a
  raw JSON escape-hatch editor covers repair, and validates JSON on save.
- Structured mutations preserve unknown keys (mutate the parsed object).
- Exactly one of `url` / `command` per server; names refuse path separators.

## Status honesty

There is no structured per-server liveness source **other than the status
extension above**, and that requires a live session. Without one the tab
shows:

1. **Installed** — read from `packages:list` (per-scope; pi loads both, so
   the merged settings view would misreport). One-click install runs
   `packages:run` — pi's own package manager, streamed — with a "restart
   sessions to apply" note. Full package management: [12-extensions.md](extensions.md).
2. **Session line** — the adapter's `setStatus` footer text for the active
   session, ANSI-cleaned, labeled as adapter-reported.
3. **Cached tools** — `~/.pi/agent/mcp-cache.json`, parsed tolerantly,
   labeled "cached".

## Code map

- Types: `shared/mcp.ts`. Main: `electron/pi/mcp-config.ts` (injectable dirs
  for hermetic tests: `electron/pi/mcp-config.test.ts`).
- IPC: `mcp:readConfigs / upsertServer / removeServer / setDisabled /
readCache / readFile / writeFile`, plus `mcp:authorize /
mcp:submitAuthCallback / mcp:cancelAuth / mcp:checkServer` and the
  `mcp:authState` broadcast
  (`electron/ipc/mcp-handlers.ts`). The in-session route adds no IPC — it
  drives pi over the existing `piCommand` path and `app:openExternal`.
- Connectors: `shared/connectors.ts` (the adapter's prompt/verdict parsers,
  shared because main and renderer both read them),
  `src/features/connectors/` (`catalog.ts`, `mcpStatus.ts`),
  `src/stores/connectors.ts`, `electron/pi/connector-auth.ts`,
  `electron/pi/connector-check.ts` (the headless connection test),
  `src/features/connectors/FlowCard.tsx` (the OAuth round-trip card),
  `src/features/connectors/ServerEditor.tsx` (the add/edit form),
  `pi-ext/mcp-status.ts`.
- UI: one tab, `src/features/settings/tabs/ConnectorsTab.tsx` — resolved
  server rows (scope badge, status chip, enable toggle, cached tool
  disclosure, directTools warning, shadow notes, OAuth flow card), the
  catalog add rows, the add/edit form, and an Advanced disclosure holding the
  adapter card and the chain file list with its raw editor. Mock cases in
  `src/dev/mockPhosphor.ts`.
- E2E: `e2e/smoke.spec.ts` "Connectors: resolved rows" — seeds `agentDir/mcp.json`,
  asserts the resolved row, toggles disable (file gains `"disabled": true`),
  adds a project server (`.pi/mcp.json` written). "Connectors" — adds Datadog
  on the EU site and asserts the written endpoint, since a per-site host that
  silently defaults to US authorizes and then returns nothing; it then adds
  Slack with a client id and asserts Add opened the flow card by itself. “Connectors:
  signing in works with no session open” drives the headless flow against the
  stub, which answers `/mcp-auth` with the adapter's real prompt shape, then
  clicks **Test** and asserts the `Up · 7 tools` verdict the stub's
  `/mcp reconnect` reply produces.
