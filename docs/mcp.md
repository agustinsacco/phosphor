# MCP (Model Context Protocol)

pi (1.2.0 and later) connects MCP servers itself, and Phosphor uses that
built-in support. There is no MCP package to install. pi reads the config,
connects the servers, signs in with OAuth, keeps the tokens and registers the
tools. MCP calls reach the chat as ordinary `tool_execution_*` events.
Phosphor's job is **config management and status surfacing**: write
`mcp.json`, run pi's own `pi mcp` commands, show whether a server is up and
what it costs.

## Config: two files

| Scope     | File                                                       |
| --------- | ---------------------------------------------------------- |
| `global`  | `~/.pi/agent/mcp.json` (honors `PI_CODING_AGENT_DIR`)      |
| `project` | `<workspace>/.pi/mcp.json`, read only for a trusted folder |

Both use the usual shape, `{"mcpServers": {name: {...}}}`, with exactly one of
`url` (streamable HTTP) or `command` + `args` + `env` + `cwd` (stdio). Other
keys pi reads: `headers`, `oauth` (client settings for servers without dynamic
registration), `auth: {provider}` (send a pi `/login` token; global file
only), `exposure`, `toolExposure`, `enabled`, `description`, `timeout`
(seconds). The types live in `libs/shared/src/mcp.ts`.

- **A project entry with the same name replaces the global one** as a whole;
  fields are not merged.
- **A project entry with no `command`, `url` or `type` is an override.** It
  may set only `enabled`, `exposure` and `toolExposure`, and it needs a global
  server of that name to override.
- **Off is `"enabled": false`.** The entry stays and pi does not connect it.
- **pi ignores the project file until the folder is trusted**: the nearest
  folder entry in pi's `~/.pi/agent/trust.json`, else
  `defaultProjectTrust: "always"` in pi's settings (`projectTrust` in
  `apps/desktop/electron/pi/mcp-config.ts`). An RPC session cannot answer pi's
  trust question, so Settings shows the state read-only: when the project file
  exists and the folder is not trusted, it says so and tells you to run `pi`
  once in a terminal there and choose Trust. Phosphor does not write trust.

pi rejects some entries and never loads them: a name outside
`[A-Za-z0-9_-]`, two names whose tool namespace (`mcp__<name>`, `-` read as
`_`) collides, a legacy SSE `type`, a non-HTTP URL, `auth` in the project file,
an override with extra keys or nothing to override. `serverProblem` and
`resolveServers` in `mcp-config.ts` mirror those rules, so such an entry shows
as a warning in Settings instead of a row that looks fine.

## Exposure: how tools reach the model

Each server (and each tool, through `toolExposure`, keyed by the server's own
tool names or `*` patterns) has one of four exposures:

| Exposure   | What the model gets                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------- |
| `codemode` | pi's default. Tools are callable from pi's `codemode` script tool, found through `tool_search` |
| `deferred` | Declared once `tool_search` loads them, then called directly                                   |
| `direct`   | Declared on every request like a built-in tool; costs the full schemas each time               |
| `hidden`   | Connected, but unreachable                                                                     |

Phosphor leaves exposure at pi's default and writes it only when you pick one
in the editor. Under codemode a server costs no schemas until a script uses
it, and a script can return just the fields it needs. Settings warns on any
server with a direct tool, and so does the composer's connector list. The
Optimization advisor's MCP tip counts only enabled servers that expose tools
directly (`apps/desktop/electron/optimization/advisor.ts`).

## Settings → Connectors

**Migration first.** While pi-mcp-adapter's config is still around, the tab
shows only the [migration card](#moving-from-pi-mcp-adapter). Everything below
assumes it is gone.

**One tab, one list.** A connector IS an MCP server, so catalog entries and
custom servers share a list. Sections, in order:

1. **Connected**: one card per server, as pi resolves the two files. The
   header carries name, a scope badge (`global`, `project`,
   `project · replaces global`, `global · project override`), the state from
   the last independent check, the catalog summary and the endpoint or command.
   **Test** checks this connector without affecting a lane. **Sign in** appears
   only after a known OAuth `needs-auth` result, never merely while checking.
   A check that itself fails (timeout, cancel, pi missing) reads **Check failed**,
   never **Down**: it says nothing about the server. **Authorize…** then
   preserves explicit OAuth sign-in/retry without claiming that authentication
   is the connection problem.
   **Tools** always remains available, including before discovery; it shows
   names, descriptions, effective exposure and search across names/descriptions.
   The sticky toolbar has **Refresh & test all**, **Cancel checks** and **Add
   custom server…**. Refresh rereads configuration, not just connection state.
   Connection details show test/discovery timestamps and credential mechanism.
   A **Selected lane** disclosure appears for a local active lane in the same
   workspace, with separate live tools and **Reconnect in lane**, but only when
   that lane's pi supports native inspection (below).
2. **Add a connector**: the curated catalog, minus anything already
   configured (matched on the URL without its query, not on the name).
3. **Advanced** (collapsed): both files with their path, server count or
   `malformed`, and the raw JSON editor. Repair tools, not daily controls.

The **editor** sets name, URL or command, exposure and scope (global, or this
project when a workspace is open). Keys it does not show (`headers`, `oauth`,
`env`, …) are kept as they were. The **enabled** checkbox writes the file that
decides it: the project file for a server it defines or overrides, the global
file otherwise. Turning a server back on removes the key, except in an
override, where an absent key would mean "inherit".

**Tool visibility** edits the native default and ordered per-tool pattern rules.
Each discovered tool also has an exact-rule selector; **Inherit rules** removes
its exact override. These mutations change only `exposure` and `toolExposure`
in the defining file or existing project override, preserving credentials and
unknown keys. There is no adapter-style **Keep connected** toggle: native pi
owns connection lifecycle.

**Shortcut in both composers.** The `Rules 2/2 · MCP 7/8` chip
(`features/chat/composer/ContextSourcesMenu.tsx`) lists the same servers with
the same enabled checkbox (`mcp:setEnabled`), flags a server with direct tools,
and shows `N tools` for a server the current lane has connected (from its
[context breakdown](#in-a-session)). Inside a lane it reads the lane's own
folder, so a worktree lane's project file is the worktree's `.pi/mcp.json`.

## Status

**Independent tests prefer `pi mcp inspect <server> --json --timeout 15`.**
This is a native pi capability, not a second MCP client. It discovers only the
selected configured server's tools, with no tool invocation or model turn.
The client accepts the version-1 inspection document and projects only bounded
names, descriptions and exposure. Native error messages are sanitized; stderr
and resolved credentials never reach the display cache.

**No pi release has `mcp inspect` yet; 1.4.0 lacks it.** Such a pi answers from
`pi mcp list --json` instead (`apps/desktop/electron/pi/mcp-list-check.ts`).
The first check probes `inspect` once; the verdict is remembered per pi binary
and version, so upgrading pi re-probes. Checks against a pi without it share one
list run per workspace and configuration, so **Refresh & test all** starts one
process, not one per card. The list connects every enabled server and reports
state, tool names and per-tool exposure, but no tool descriptions. pi exits 1
when any server is not connected; that report still counts
(`runMcpList` in `libs/session-runtime/src/pi/mcp-inspection.ts`, which the
Host's aggregate check uses too). A list that fails shows a generic message,
never pi's stderr. Configuration, enabling and sign-in use pi's established
commands either way.

**A list answers at the pace of its slowest server.** A local command server
started through `uvx` takes seconds where an HTTP server takes under one, and pi
allows each server 60-second requests plus a 25-second wait on another
process's OAuth refresh lock. So the list's process cap is 150 seconds, past
pi's own bounds: a slow server reports `failed` without taking the others down,
and no refresh is cut short. Cancel stops the cards waiting, never the run. Every
finished run is saved for every connector, even when nobody waits for it, unless
the configuration changed meanwhile. Each run logs one `mcp list finished` line
to `phosphor.log` with its duration and each server's state.

Opening the tab loads remembered metadata, then checks connectors. A card keeps
its last known state while a new check runs (`Up · 3 tools · checking…`), and
after 10 seconds the toolbar says checks are still running. With `mcp inspect`,
one failed or slow server never withholds the others. Main limits concurrency to
three processes, including processes draining after reporting. A visible check
has a 30-second wait bound. Native credential-command resolution and OAuth-safe
cleanup can outlast the discovery deadline: cancel abandons queued checks and
stops waiting for active ones, but lets native cleanup finish. A separate
120-second process-tree deadline prevents orphan probes. Normal quit waits for
that bounded drain so refreshed credentials can be saved; emergency shutdown
cannot wait and forcibly terminates remaining probe trees.

The private `mcp-inspections.json` under Desktop's user-data directory keeps at
most 64 display snapshots within 4 MiB. Its keys hash workspace, server, scope
and configuration; no raw configuration or resolved credentials are stored.
A failed test retains the previous successful tool list with its discovery time.
Changed configuration invalidates that snapshot, and late results cannot replace
newer workspace/configuration state. The mounted tab rereads config on focus and
every 15 seconds while visible; unchanged config does not launch more tests.

**Live lane state is separate from independent tests.** For the selected local
lane, `mcp:laneControl` enters the session service. Before dispatch it verifies
that `get_commands` reports native `mcp` provenance (`builtin:mcp`, source
`builtin`) and the `[inspection-v1]` capability marker; no pi release has it
yet. Without it the answer is `unsupported`, and the card hides **Selected
lane** and stops polling that lane. With it, main sends
`/mcp inspect|reconnect <name> --json --request <token>` and correlates the
versioned `mcp-inspection` status on token, operation and server. A prompt
acknowledgment alone is not success. Inspection reads current native state,
including the latest completed tool discovery, without connecting anything.
Visible settings request a new lane snapshot every 20 seconds.

Reconnect uses the lane's loaded config and does not sign in or enable servers.
The session service refuses it while another mutating command is admitted,
and native pi checks idle state before reconnect. New mutating host commands
are refused until native completion, even if the frontend's wait notice has
appeared. Read-only commands and abort remain available. Native tool readiness
protects calls started internally; the extension API itself has no global idle
reservation. Routine-owned lanes cannot be controlled here. Provider-token
(`auth.provider`) reconnect is explicitly unsupported by the machine API;
inspection still works. Saved config changes retain the existing before-next-turn
reload behavior described below.

The shared inspection runner and parser live in `libs/session-runtime` and
`libs/shared`. This restored workflow is Desktop-local. Host machine settings
retain their existing revision-checked configuration, aggregate checks and
login tasks; the PWA does not gain these new controls. These Desktop IPC channels
do not bypass Host settings authorization or route local credentials remotely.
Adding full inspection to that separate Host surface requires its own granted
settings contract, rather than forwarding Desktop IPC.

## Sign-in

**Phosphor never holds a connector token.** pi does OAuth (PKCE, dynamic
client registration or a preregistered client, the loopback callback) and
stores the tokens in its agent directory. Phosphor writes `mcp.json` and runs
pi's commands.

- **Sign in** runs `pi mcp login <server> --timeout 300` with stdin ignored, so
  pi knows it is not on a terminal and waits for the browser instead of asking
  for a pasted URL. pi prints the authorization URL and opens the browser
  itself. Phosphor shows that URL with **Open again** (for a closed tab) and
  **Cancel**, which kills the process and with it pi's loopback listener. Exit
  0 is signed in; anything else is a failure with pi's last stderr line.
- **Nothing answers a dialog for pi.** There is no paste-the-callback fallback,
  and no Phosphor code answers an extension-UI prompt on pi's behalf.
- **Remove** of an OAuth server (a URL without an Authorization header or
  `auth`) runs `pi mcp logout <server>` first, while the entry still says where
  the tokens are, then deletes the entry.
- **Running sessions pick up new credentials on their next turn.** Signing in
  never needs a session, and an open one does not need a restart.
- Progress arrives on the `mcp:authState` broadcast into
  `stores/connectors.ts`; `FlowCard.tsx` renders it. Quitting the app kills a
  sign-in still running.

## The catalog

Fourteen curated OAuth connectors: Linear, Notion, Braintrust, Datadog,
Supabase, Questrade, Fellow, Slack, and Google Workspace's Gmail, Drive,
Calendar, Docs, Sheets and Slides. Each endpoint is checked against the vendor's docs
_and_ the server's own OAuth metadata, because a wrong URL fails as "broken
auth" (`libs/client-ui/src/features/connectors/catalog.ts`).

**Add starts the sign-in.** Add writes `{url}` to the global file (plus
`oauth` where the entry needs it) and immediately runs `pi mcp login`, so the
row appears in Connected with its flow card open and the browser already
launched.

**Two connectors default to read-only, on purpose.** With no `oauth.scope`
the MCP SDK requests every scope the server advertises, and for a brokerage
that includes placing orders. Questrade pins its read scopes
(`QUESTRADE_READ_SCOPES`; the write scopes are named so a test can assert they
never leak). Supabase's knob is a query parameter, so its `read_only=true`
endpoint is the default; that constrains the SQL user, not the OAuth grant,
and without `?project_ref=<ref>` the server reaches every project in the
account.

**Slack and Google cannot be one click**, and their rows say why.

Slack:
Slack supports neither SSE nor dynamic client registration, so MCP clients
must be backed by a registered Slack app. You register an app and paste its
**client ID**; Add stays disabled until you do. Add then writes
`oauth: {clientId, clientSecret?, callbackUrl, scope}` with the fixed callback
`http://localhost:19876/callback`, since the redirect URI must be registered
up front and match byte for byte. Slack accepts a `localhost` redirect only
from an app with **PKCE** enabled, which makes it a public client, so the
secret is optional and an empty one is never written. Only internal or
Marketplace-published apps may use MCP, and the app's user scopes must cover
what Phosphor asks for: the row's "Set up the app" disclosure hands over an
app manifest that sets scopes, redirect URL and `pkce_enabled` in one paste,
and `oauth.scope` is written from the same list.

Google Workspace has no dynamic registration either, and each product is its
own server (`<product>mcp.googleapis.com/mcp/v1`), so each is its own row
and its own sign-in. You create a **Web application** OAuth client in your own
Cloud project (enrolled in the Workspace Developer Preview, with "Use this
client for an AI-powered agent" ticked) and paste its client ID **and secret**:
it is a confidential client, so Add stays disabled without both
(`secretRequired`). One client serves every product. The redirect URI is the
same fixed callback as Slack. Scopes are pinned to Google's documented set
(`GOOGLE_WORKSPACE_PRODUCTS`), because the advertised default includes full
mailbox access (`https://mail.google.com/`), `gmail.send` and full `drive`.
Google issues a refresh token only when the authorization request carries
`access_type=offline`, which pi does not send, so a Google sign-in lasts about
an hour; the row says so.

## In a session

pi connects a session's servers after it starts and registers each server's
tools under the namespace `mcp__<server>`. pi registers one `/mcp` command
(built into pi); MCP servers add no `/` commands of their own.

**In the transcript**, MCP calls mostly appear as pi's own tools: `codemode`
renders as **Ran a script** with the script's first line, and `tool_search` as
**Searched tools for** with the query
(`features/chat/tools/toolSummaries.ts`). The calls a script makes carry
`parentToolCallId` and get no rows of their own. A `direct` or `deferred`
tool is an ordinary tool row under its own name.

**The context meter** gets per-server numbers from the bundled
`context-breakdown.ts`. It attributes each tool to a server by pi's tool
namespace (whose alias is the configured name), counts every tool pi has
registered for the server, and measures the schemas in the window. Since pi
registers tools as each server answers, with no event for it, the extension
re-checks once a second for the first minute after a session starts and
re-publishes only when the set of MCP tools changed. A codemode server reads
`0/N` there: up, and costing nothing until a script calls it
([chat.md](chat.md#what-the-context-meters-popover-shows)).

**Running lanes pick config changes up before their next turn.** pi reads
`mcp.json` and its package settings when a lane starts, so main reloads a
lane's extensions right before a prompt whose config changed since the lane
last loaded it
(`libs/session-runtime/src/pi/lane-reload.ts`, inside pi
`libs/pi-extensions/pi-ext/lane-reload.ts`). The process, transcript, model
and thinking level stay. On pi 1.2.0 a server turned off loses its tools and a
newly enabled one is back, with its exposure, on the next request.

- **When.** Only before a prompt that starts a turn: not mid-run (a steer or
  follow-up joins the running turn), not for host controls, not for routine
  lanes. Turns the agent starts itself (a sub-agent's completion waking the
  parent) wait for your next message.
- **What counts as a change.** A fingerprint of the lane's two `mcp.json`
  files, global and `<lane>/.pi/mcp.json`, plus `packages` and `extensions` in
  both `settings.json` files (`apps/desktop/electron/pi/lane-config.ts`). The
  settings are what the migration changes, so an open lane drops the adapter
  and turns pi's MCP on in the same reload; other settings pi rewrites itself,
  such as the last model, do not count. Files are re-read only when their stat
  changes, and hashed as canonical JSON, so a reformat or an unchanged save is
  not a change. A trust decision made later reaches new lanes only.
- **Refusals wait, they never force.** pi-subagents keeps background children
  across a reload but stops a running async workflow and detached foreground
  children, and a pending completion must reach the parent first. The
  extension asks pi-subagents through the liveness registry pi-web defines
  (`Symbol.for('@agegr/pi-web/session-liveness/v1')`, which it provides) and
  skips the reload while any work is live; the next prompt tries again.
- **What a reload resets.** Every extension starts over. The context budget is
  re-sent after the reload, before every prompt as always; the lane's
  CLAUDE.md / AGENTS.md choice is restored from the session
  ([chat.md](chat.md#context-files)). The next request misses the prompt
  cache because the tools changed, which any way of changing them would.
- **Unsupported pi.** Main asks `get_commands` first and never sends
  `/phosphor-reload` to a pi without it, where it would reach the model as
  text.

## The Claude provider reaches MCP through pi, not around it

A `pi-claude-cli` session has **two** possible sources of MCP servers, and
only one of them is Phosphor's.

1. **pi's two files**, loaded by pi's built-in MCP, which registers its tools
   in pi's tool registry. pi-claude-cli snapshots the current request's tools
   into a schema-only MCP server it hands the CLI as `--mcp-config`, so pi's
   `codemode` and `tool_search` (and any direct MCP tool) arrive under the
   `mcp__custom-tools__` prefix. The schema server proxies `tools/call` back to
   pi; pi runs the real tool and returns the result to the same persistent CLI
   process.
2. **The Claude CLI's own chain**: `~/.claude/.mcp.json`, `~/.claude.json`,
   and claude.ai account connectors. Phosphor neither reads nor writes these.

Servers from (2) are a problem, not a bonus: they never become pi tool events,
so `worktree-paths.ts` cannot guard them, the context meter cannot see them,
and the same project behaves differently on two machines. Every spawn enforces
`PI_CLAUDE_CLI_CONTEXT=pi`, which implies strict MCP isolation and excludes
chain (2). pi keeps its project and skill loading; the provider suppresses
independent Claude discovery, replaces its system prompt and disables native
tools. Explicit host guards and managed policy remain active. Tool calls and
complete results are normal pi messages, not native Claude marker previews.

**Requires an installed pi-claude-cli ≥ 0.10.0.** Phosphor verifies the package
before starting or switching to Claude. pi supplies and executes all tools,
including the coding tools, over this bridge. The provider automatically
reimports pi history instead of resuming an old-policy Claude transcript.
Claude Code **2.1.263+** is required.

## Moving from pi-mcp-adapter

pi-mcp-adapter turns pi's built-in MCP off (it adds `-builtin:mcp` to pi's
settings) and reads files of its own. While any of these is true, Settings →
Connectors shows **only** a migration card, because Phosphor manages the
built-in alone:

- `~/.pi/agent/mcp-adapter.json` or `<workspace>/.pi/mcp-adapter.json` exists;
- pi's global `settings.json` `extensions` holds `-builtin:mcp` or
  `!builtin:mcp`;
- the pi-mcp-adapter package is installed, in either scope.

Until then the adapter keeps working: pi loads it and nothing is rewritten.
Phosphor just no longer shows or signs in to those servers. So people find the
card without opening Settings, every launch with the adapter set up globally
shows a notice, "Move your MCP connectors", that opens Connectors
(`libs/client-ui/src/features/connectors/migrationNotice.ts`). It moves nothing.

**The card previews the whole change** (`mcp:migrationPlan`): each server and
the file it goes to, with a note for anything translated or dropped; servers
that cannot move, with the reason; the files renamed; whether the built-in is
turned back on; the packages removed; and which servers need a new sign-in.
An unreadable source blocks the button until it is fixed.

**Move to pi's MCP** then runs two steps, config first, so a failed package
removal still leaves a working setup once the package goes:

1. Main recomputes the plan from disk (`mcp:migrate`; never the renderer's
   copy, so a file edited since the preview is not overwritten blind), then:
   - replays the adapter's chain (`~/.config/mcp/mcp.json`,
     `~/.agents/mcp.json`, `~/.agents/mcp/mcp.json`, `~/.pi/agent/mcp.json`,
     `~/.pi/agent/mcp-adapter.json`; per project `.mcp.json`, `.pi/mcp.json`,
     `.pi/mcp-adapter.json`) with its field-by-field merge, to get the config
     each server actually ran with;
   - writes the translated servers into pi's `mcp.json` for the same scope,
     after copying an existing file to `.bak-<time>`. pi's `mcp.json` was one
     of the adapter's files (older adapters kept everything there), so its
     entries are translated too; one already in pi's shape is left alone;
   - renames the adapter's own files to `.migrated-<time>`;
   - removes `-builtin:mcp` / `!builtin:mcp` from pi's settings, after a
     `.bak-<time>` copy.
2. pi removes each installed pi-mcp-adapter package (`packages:run remove`),
   with its output streamed into the card.

Files the adapter shared with other MCP clients (`~/.config/mcp/mcp.json`,
`~/.agents/mcp.json`, `.mcp.json`) are read for the merge and never written.
Only scopes the adapter was running are planned: one with its own file, and
both while pi's MCP is turned off. So once global config has moved, a project
that still has `.pi/mcp-adapter.json` moves only its own servers, and the
shared files are not merged into the global file a second time.

**Translation** (`translateEntry` in `apps/desktop/electron/pi/mcp-translation.ts`)
keeps what pi understands and says what it drops. Some examples: a bearer token
becomes an `Authorization` header (`bearerTokenEnv` becomes
`Bearer ${VAR}`); a `caFile` is dropped with a hint to use `NODE_EXTRA_CA_CERTS`;
`directTools` becomes `direct` (all), per-tool `direct` rules (a list) or
`deferred` (`"search"`); include and exclude filters become `toolExposure`
rules; `disabled` becomes `enabled: false`; a loopback `oauth.redirectUri`
becomes `oauth.callbackUrl`. A server behind an rmcp-mux `socket` is skipped.
Adapter-only settings with no meaning in pi (`lifecycle`, `idleTimeout`,
`toolPrefix`, …) are dropped silently.

**Sign in again afterwards.** Credentials do not move: the adapter kept its
tokens in the OS credential store and pi keeps its own, so every OAuth server
signs in once more, and the card names them. The adapter's old tokens stay in
the credential store. Open sessions switch over before their next message:
the lane reload follows the `packages` and `extensions` settings as well as
`mcp.json` ([In a session](#in-a-session)), so a lane that reloads between the
two steps reloads again once the package is gone.

The adapter's commands (`/mcp-auth`, `/mcp-adapter`, `/pi-mcp`, its MCP
prompts) and its `mcp` / `mcpScript` tools go with the package.

## Rules

- **Renderer sends scope enums, never paths.** Path resolution lives in
  `apps/desktop/electron/pi/mcp-config.ts` only.
- Malformed files are surfaced, never overwritten by structured writes. The raw
  JSON editor covers repair and refuses to save invalid JSON.
- Structured mutations preserve unknown keys, top-level and per server.
- Exactly one of `url` / `command` per server.

## Code map

- Types: `libs/shared/src/mcp.ts`.
- Main: `apps/desktop/electron/pi/mcp-config.ts` (the two files, resolution,
  trust; injectable dirs for hermetic tests), `mcp-migration.ts` (the adapter
  migration: `mcp-translation.ts` holds the per-entry rules and
  `mcp-migration-plan.ts` the plan), `mcp-cli.ts` (`pi mcp list / login / logout`), `mcp-actions.ts`
  (working directory, environment and admission for those commands),
  `mcp-inspection.ts` and `mcp-list-check.ts` (connector checks, with the
  stock-pi list fallback). The e2e stub behaves like stock pi under
  `PHOSPHOR_E2E_STOCK_PI_MCP`.
- IPC: `mcp:readConfigs / upsertServer / removeServer / setEnabled`,
  `mcp:readFile / writeFile`, `mcp:list`, `mcp:authorize / cancelAuth / logout`,
  `mcp:migrationPlan / migrate` and the `mcp:authState` broadcast
  (`apps/desktop/electron/ipc/mcp-handlers.ts`).
- Renderer: `libs/client-ui/src/features/settings/tabs/ConnectorsTab.tsx`,
  `libs/client-ui/src/features/connectors/` (`catalog.ts`, `mcpStatus.ts`,
  `FlowCard.tsx`, `MigrationCard.tsx`, `ServerEditor.tsx`, `useMcpServers.ts`),
  `libs/client-ui/src/stores/connectors.ts`. Mock cases in
  `libs/client-ui/src/dev/mockPhosphor.ts`.
- In pi: `libs/pi-extensions/pi-ext/context-breakdown.ts` (per-server counts),
  `lane-reload.ts` (applying changes between turns).
