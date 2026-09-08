# Connectors: six services, OAuth, and no tokens in Phosphor

Date: 2026-08-27

## What changed

Settings gained a **Connectors** tab. Six services — Linear, Notion,
Braintrust, Datadog, Fellow, Slack — are one row each: pick a region or site
where the vendor has one, press Add, press Sign in, approve in the browser, and
the row goes green with a tool count. Before this, the MCP tab could write a
`mcp.json` entry and nothing else: there was no way to authorize an OAuth
server from the UI at all, so an OAuth-only connector could be configured and
then never used.

Two smaller things came with it. The session footer now shows MCP as a chip
(`MCP 2/3 · 48 tools`) that opens the tab, instead of the adapter's prose
sentence. And the context meter attributes MCP schema cost **per server**,
which is what makes "should I disable Datadog?" answerable.

Plan and findings: [backlog/connectors.md](../specs/backlog/connectors.md). Live
contract: [reference/mcp.md](../mcp.md#connectors-settings--connectors).

## The decision that shaped everything: Phosphor holds nothing

`pi-mcp-adapter` already implements OAuth 2.1 with PKCE, dynamic client
registration, a loopback callback server, refresh, and token custody in the OS
credential store. So the interesting question was never "how do we do OAuth",
it was "how little can Phosphor do".

The answer: Phosphor writes `mcp.json`, sends the adapter's own
`/mcp-auth <server>` command into a session, and opens a browser. That is the
whole feature. **The main process gained no code** — no new IPC channel, no
`mcp:startConnect`, no hidden session, none of which the plan expected to
avoid. Sign-in costs no tokens either, because pi runs an extension command
immediately without an LLM call.

The alternative — importing the adapter's `startAuth`/`completeAuth` from the
main process — was rejected on evidence: only `./oauth` (read tokens) is in the
package's `exports` map, the auth module is not exported, and this package is
versioned independently of Phosphor with nothing pinned. The `pi-claude-cli`
history in [CLAUDE.md](../../CLAUDE.md) is what that road looks like.

## The trap that will bite anyone who touches this

pi's RPC dialog protocol has **no server→client cancel**. Only the client may
answer an `extension_ui_request`.

The adapter races two things when it authorizes: the loopback callback, and a
"paste the callback URL" prompt as a fallback. When the callback wins, the
adapter aborts its own prompt internally — and Phosphor is never told. The obvious
tidy-up, answering the now-orphaned request so the dialog goes away, is exactly
wrong: an empty or cancelled answer _wins that race instead_ and throws
`OAuth authentication cancelled`, killing a flow that had already succeeded and
written tokens.

So the rule is: **Phosphor never auto-answers.** A pending request stays pending
and hidden; only an explicit user Cancel answers it. `stores/connectors.test.ts`
asserts that `promptReceived` sends no response, because this is the kind of
thing a future refactor "cleans up".

The interception also cannot live in the Settings window, which was the first
design. The adapter auto-authenticates _mid-turn_ when a model calls a tool
whose server has no token, so the OAuth prompt can appear during ordinary
chat. It is handled in `stores/extensionUi.ts`, globally.

## A bug found by reading the adapter, not by using Phosphor

`pi-ext/context-breakdown.ts` classified MCP tools by an `mcp__` name prefix.
The adapter renames MCP tools four different ways depending on `toolPrefix`,
and the **default** is `server` → `<server>_<tool>`. So under the default
setting, with promoted tools, every connector's schemas were counted as pi's
own built-in tools: the "MCP tools" slice read 0 while thousands of tokens of
connector schema sat in the window.

`classifyToolServer` now handles all four modes plus namespace proxies, takes
server names from the adapter's status snapshot, sorts candidates longest-first
so `linear` cannot claim `linear-readonly_*`, and reports a genuinely
unattributable name (`toolPrefix: "none"`) as built-in rather than guessing.

## Vendor facts that are not optional

Each of these turns into a support ticket if the UI pretends otherwise:

- **Slack** does not support dynamic registration. It needs a Slack app's
  client id/secret and an exactly-matching redirect URI, which pins the
  adapter's callback port (19876 by default).
- **Datadog**'s endpoint host is per site. The wrong one authorizes fine and
  then returns nothing, which is why the e2e test adds the EU site and asserts
  the written URL.
- **Braintrust** has separate US and EU data planes.
- **Fellow** requires a workspace admin to enable MCP connections first.
- **Linear** has a distinct read-only endpoint, offered as a checkbox.
- Several vendors still serve a legacy `/sse` path. A catalog test asserts no
  entry uses one — its failures read as broken auth, not a deprecated
  transport.

## Deviations from the plan

- No `mcp:startConnect` / `mcp:cancelConnect` / `mcp:logout` IPC and no
  `mcp:connectState` channel. The renderer already had everything needed
  (`piCommand`, `app:openExternal`, the extension-UI stream), and adding main-
  process code for it would have been ceremony.
- No hidden connector session. Sign-in uses the active session and the tab says
  so when there is none. **Closed the same day** by
  [2026-08-27-connectors-headless-signin.md](2026-08-27-connectors-headless-signin.md),
  which spawns a throwaway `pi --no-session` for the flow.
- Braintrust's API-key alternative is not surfaced; `pi-mcp-adapter token set`
  already covers it and the MCP tab can write the config.

## Verification

`npm run typecheck`, `npm run lint`, `prettier --check .`, 1252 unit tests
(30 new across the catalog, the status parser, the OAuth prompt parsers, the
flow store, the interception and tool classification), and the e2e suite
including a new "Connectors" case. F4 stays open in the backlog because it is
upstream, not because it is unhandled.
