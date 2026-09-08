# Connectors: OAuth MCP servers as a first-class surface

Audit + build plan. Written 2026-08-27 against `pi-mcp-adapter@2.29.0`.
All four build phases below have since shipped; every finding carries its own
status, and only F4 (upstream) is still open.

**The ask.** Settings → **Connectors**: a catalog of real services (Linear,
Notion, Braintrust, Datadog, Fellow, Slack first), each connected with OAuth in
one click, each row honestly showing whether it is authorized and what it
contributes. Plus: the session footer shows MCP state as prose, is clickable,
and opens a full view of what is filling the context window.

## What already exists — do not rebuild it

| Capability                                                                                               | Where it lives                                                            |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| OAuth 2.1 + PKCE + dynamic client registration                                                           | adapter `mcp-auth-flow.ts` (`startAuth`/`completeAuth`)                   |
| Loopback callback server, default `http://localhost:19876/callback`                                      | adapter `mcp-callback-server.ts`, `mcp-oauth-provider.ts:87`              |
| Token custody in the **OS credential store**, service `pi-mcp-adapter.oauth`, chunked for Windows        | adapter `mcp-auth.ts`                                                     |
| `getAuthStatus` → `authenticated \| expired \| not_authenticated`, `removeAuth`, refresh                 | adapter `mcp-auth-flow.ts:933`                                            |
| Per-server status snapshot (connected / needs-auth / failed / cached / disabled, tool + resource counts) | adapter `mcp-status.ts`                                                   |
| `/mcp-auth <server>`, `/mcp logout`, `/mcp reconnect`                                                    | adapter `commands.ts:248`                                                 |
| Static bearer tokens in the same credential store                                                        | `pi-mcp-adapter token set <server>` + `bearerTokenStore: true`            |
| Phosphor-side config chain CRUD, scope badges, raw `mcp.json` editor                                     | `src/features/settings/tabs/McpTab.tsx`, [reference/mcp.md](../../mcp.md) |

So Phosphor is not building OAuth. It is building **actuation, custody-free
status, and a catalog** on top of an adapter that already does the protocol.

## Decisions

**D1 — Phosphor never stores a connector token.** Not in `electron-store`, not in
a Phosphor keychain entry, not in memory beyond a render. Two copies of a refresh
token means one of them is always stale, and the adapter is the only party that
knows when it rotated. Phosphor owns `mcp.json` and the catalog; the adapter owns
secrets.

**D2 — auth is actuated by the adapter's own command, in a pi session.** The
package `exports` map only publishes `.`, `./types`, `./oauth`, `./config`,
`./metadata-cache`. `./oauth` is read/inspect/update **tokens** only;
`startAuth` / `completeAuth` / `getAuthStatus` live in `mcp-auth-flow.ts`,
which is not exported — a deep import breaks on any adapter release, and this
package is separately versioned with Phosphor pinning nothing (see
[CLAUDE.md](../../../CLAUDE.md) on `@saccolabs/pi-claude-cli` for how that goes).
So Phosphor sends `{type:'prompt', message:'/mcp-auth linear'}`. Per pi's
`docs/rpc.md:67` an extension command "executes immediately" and manages its
own LLM interaction — `/mcp-auth` calls no model, so **the connect flow costs
zero tokens**.

**D3 — status arrives over the extension status channel, not by inference.**
The adapter assigns `state.statusEvents = pi.events` (`index.ts:525`) and
publishes `pi-mcp-adapter/status/v1` snapshots on pi's shared cross-extension
bus. A new bundled extension `pi-ext/mcp-status.ts` subscribes and re-publishes
the snapshot as JSON under status key `Phosphor-mcp-status`. That key is
structured, so it must be added to `STRUCTURED_STATUS_KEYS`
(`src/features/extension-ui/ExtensionUiHosts.tsx:231`) or it lands in the strip
as raw JSON — exactly the bug fixed in #88.

**D4 — one short-lived connector session per connect.** Reuse the workspace's
live session if there is one, otherwise spawn a hidden session through the
existing `SessionRegistry` and dispose it
when the flow settles. Settings must work with no session open, which
`AdapterSessionStatus` currently does not (F5).

**D5 — Connectors is the new primary surface; the MCP tab becomes its
advanced drawer.** Catalog, connect, disconnect, per-row status in
`Connectors`; the resolution chain, shadowing and raw JSON editing stay where
they are for repair work.

## The connect flow, and the two traps in it

```
Connectors row → mcp:startConnect(name)
  main: ensure server entry in mcp.json (catalog URL + scope)
  main: session.prompt('/mcp-auth <name>')            ← no model call
  adapter: startAuth → binds localhost:19876, opens PKCE authorize URL
  adapter: ctx.ui.input("Complete <name> OAuth …<url>… paste callback URL")
  Phosphor:  intercepts that request, does NOT render the generic dialog,
          shell.openExternal(url), shows a "Waiting for <name>…" card
  browser: user approves → loopback callback wins the race
  adapter: writes tokens to the OS credential store, reconnects, publishes status
  Phosphor:  row flips to Connected when Phosphor-mcp-status says so; session disposed
```

**Trap 1 — pi's RPC dialog protocol has no server→client cancel.** Requests
are `extension_ui_request` and only the client may answer
(`docs/rpc.md:1150`). When the loopback callback wins,
`waitForAuthorizationResponse` aborts its own input signal
(`mcp-auth-flow.ts:617`) and Phosphor is never told. Worse, Phosphor must **not**
"tidy up" by replying `cancelled: true` or with an empty value: an empty manual
input wins the race and throws `OAuth authentication cancelled`, killing a flow
that had already succeeded. Correct behaviour: leave the request pending,
hidden, and let session disposal collect it. Keep a visible **Paste callback
URL** escape hatch that answers the same pending id, for the case where the
loopback port was taken.

**Trap 2 — the same dialog can appear mid-turn, in a normal session.**
`proxy-modes.ts` auto-authenticates when the model calls a tool whose server
needs auth. So the interception is a global rule in the extension-UI layer
keyed on the adapter's prompt shape, not a modal owned by the Settings window.

## Catalog — verified endpoints

All six speak Streamable HTTP; all six use OAuth. Sources are the vendors' own
docs, checked 2026-08-27.

| Connector      | URL                                | Auth                            | The thing that will bite                                                                                    |
| -------------- | ---------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Linear**     | `https://mcp.linear.app/mcp`       | OAuth 2.1 + DCR — one click     | `…/mcp/readonly` is a real second endpoint; offer read-only as a checkbox. `/sse` is deprecated.            |
| **Notion**     | `https://mcp.notion.com/mcp`       | OAuth + DCR — one click         | `/sse` exists as legacy; never default to it.                                                               |
| **Braintrust** | `https://api.braintrust.dev/mcp`   | OAuth **or** API key            | EU data plane is `https://api-eu.braintrust.dev/mcp` — must be a choice, not a guess.                       |
| **Datadog**    | `https://mcp.datadoghq.com/v1/mcp` | OAuth 2.1 + DCR — one click     | Host is per **site** (`mcp.datadoghq.eu`, us3/us5/uk1/ap1/ap2); `?toolsets=all` widens a default subset.    |
| **Fellow**     | `https://fellow.app/mcp`           | OAuth                           | A workspace admin must first enable _Security → Allow users to create MCP connections_, or auth just fails. |
| **Slack**      | `https://mcp.slack.com/mcp`        | **Pre-registered** app — no DCR | Needs a PKCE Slack app's `client_id` (public client, no secret) and an **exact** registered redirect URI.   |

Slack is the one connector that cannot be one-click, and it dictates a config
shape the others do not need:

```jsonc
"slack": {
  "url": "https://mcp.slack.com/mcp",
  "auth": "oauth",
  "oauth": {
    "clientId": "${SLACK_MCP_CLIENT_ID}",
    "redirectUri": "http://localhost:19876/callback",
    "scope": "canvases:read canvases:write …" // SLACK_USER_SCOPES
  }
}
```

Re-checked 2026-09-04 against Slack's own metadata, which moved the shape:
Slack accepts a `http://localhost` redirect URL only from an app with **PKCE**
enabled, and a PKCE app is a public client, so `clientSecret` is now optional
and omitted by default. `oauth.scope` is required in practice — without it the
MCP SDK requests every scope in `.well-known/oauth-protected-resource` and
Slack rejects the authorization for anything the app has not declared.

The adapter reads exactly these keys (`extractOAuthConfig`,
`mcp-auth-flow.ts:156`) and interpolates `${ENV}`. The redirect URI must match
the adapter's callback binding, so a pre-registered client also means the port
is not negotiable: default `19876`, overridable only by
`MCP_OAUTH_CALLBACK_PORT`, and a busy port fails the flow with a specific error
(`mcp-callback-server.ts:412`). The Slack row therefore has two steps —
credentials, then connect — and the UI should say why.

## Context window view

The meter at `4%` is already a button with a popover
(`src/features/chat/composer/ContextMeter.tsx`); what is missing is that it
cannot answer the question connectors create — _which connector is eating my
window?_ Six connectors with `directTools` can add hundreds of schemas.

Work: group MCP schema cost **per server** in `pi-ext/context-breakdown.ts`,
list the largest contributors, and make the footer's MCP entry open the same
inspector. Component sizes stay labelled as estimates — only pi's total is
authoritative ([reference/extensions.md](../../extensions.md)).

## Findings

| #   | Finding                                                                                                                                                                                                                                                                                                       | Status                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| F1  | The status strip rendered the lane-loop payload as raw JSON.                                                                                                                                                                                                                                                  | **fixed** — `2002d12` (#88)                                                                                       |
| F2  | `pi-ext/context-breakdown.ts` classifies MCP tools by a `mcp__` name prefix. That only matches namespace proxies (`mcp__<server>`) and `toolPrefix: "mcp"`. The adapter's **default** is `toolPrefix: "server"` → `<server>_<tool>` (`types.ts:741`), so direct connector tools are billed to pi's built-ins. | **fixed** — `classifyToolServer`, all four prefix modes tested                                                    |
| F3  | Settings → MCP has no auth affordance at all: no OAuth fields, no bearer token, no Connect. OAuth-only servers can be configured but never authorized from the UI.                                                                                                                                            | **fixed** — Settings → Connectors                                                                                 |
| F4  | pi's RPC has no cancel for a pending dialog, and an empty answer aborts a successful OAuth flow (Trap 1).                                                                                                                                                                                                     | **open** — upstream; contained by never auto-answering, guarded by `stores/connectors.test.ts`                    |
| F5  | `AdapterSessionStatus` reads the active session's status text, so Settings opened with no live session reports nothing about MCP.                                                                                                                                                                             | **fixed** — sign-in no longer needs a session at all (headless flow); a row with no session reads “state unknown” |
| F6  | No catalog: every server is hand-typed, including its URL. Nothing prevents `mcp.notion.com/sse`.                                                                                                                                                                                                             | **fixed** — `features/connectors/catalog.ts`                                                                      |
| F7  | The context popover cannot attribute schema cost per MCP server, which is the whole cost of adding connectors.                                                                                                                                                                                                | **fixed** — `mcpByServer` + per-server rows in the meter                                                          |

## Phases

All four landed in one pass; deviations are recorded in the log entry.

1. **Catalog + config.** Done — `src/features/connectors/catalog.ts`, the
   Connectors tab, per-row Add with region/site/read-only options and Slack's
   credential step, written through the existing `mcp:upsertServer`.
2. **Connect / disconnect.** Done. First pass was renderer-only over existing
   IPC; the follow-up added the planned main-process flow after all
   (`mcp:authorize` + `electron/pi/connector-auth.ts`), because sign-in that
   requires a live session is useless on a fresh launch. Both routes exist: a
   throwaway `pi --no-session` for Settings, the live session's own channel for
   the adapter's mid-turn auto-auth.
3. **Honest status.** Done — `pi-ext/mcp-status.ts` → `Phosphor-mcp-status` →
   per-row badges and a clickable footer chip.
4. **Context inspector.** Done — per-server MCP grouping and the prefix fix.

## Verification

- Unit: catalog entries (every URL absolute https, no `/sse` defaults), the
  connect state machine including "callback wins while a paste dialog is
  open", `Phosphor-mcp-status` parsing of malformed input, and tool→server
  classification across all four `toolPrefix` modes.
- E2E: add a catalog connector and assert the written `mcp.json`; drive a
  connect against a stub authorization server, never a real vendor.
- Manual, once per phase: one real Linear connect (DCR path) and one real
  Slack connect (confidential path) — they exercise different code.

## Non-goals

Organization-level authorization, parity with Claude's connector directory,
any storage of tokens by Phosphor, and a general bearer-token UI beyond
Braintrust's API-key alternative (`pi-mcp-adapter token set` already covers the
rest).
