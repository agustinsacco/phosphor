# Why the Slack connector still asks for a client id

2026-09-08.

The question was why Slack is not "pure OAuth" in pidex when Claude Desktop
adds it with one click and a browser window, like every other connector. The
answer is not a pidex gap in the flow. It is app identity, and it is decided
outside this repo.

## What was checked

- `https://mcp.slack.com/.well-known/oauth-authorization-server` — re-probed
  today. `authorization_endpoint` `https://slack.com/oauth/v2_user/authorize`,
  `token_endpoint` `https://slack.com/api/oauth.v2.user.access`, S256 PKCE, 30
  user scopes, and **no `registration_endpoint`**. Dynamic client registration
  is still absent, matching Slack's prose: "We do not support SSE-based
  connections or Dynamic Client Registration at this time."
- Slack's App Identity rule, unchanged: "MCP clients must be backed by a
  registered Slack app with a fixed app ID and hardcode that app ID," so Slack
  can route admin approval, audit logs, rate limits and access control to a
  named app. "Only directory-published apps or internal apps may use MCP."
- `pi-mcp-adapter` 2.32.1 — `extractOAuthConfig` reads a per-server
  `oauth.clientId`, `oauth.clientSecret`, `oauth.scope` and `oauth.redirectUri`
  (`mcp-auth-flow.ts`). A configured `redirectUri` wins over the adapter's own
  port (`mcp-oauth-provider.ts`) and makes the callback server bind that exact
  port (`strictPort`). Nothing in the package knows about Slack specifically.

## Why Claude Desktop is one click

Because Anthropic ships a registered Slack app and hardcodes its id — the same
thing Cursor and Perplexity do, and the reason those four are the names on
Slack's "available clients" list. Slack publishes Claude Code's in the open.
The Slack plugin's config, verbatim from
[connect-to-harnesses](https://docs.slack.dev/ai/slack-mcp-server/connect-to-harnesses):

```json
{
  "mcpServers": {
    "slack": {
      "type": "http",
      "url": "https://mcp.slack.com/mcp",
      "oauth": { "clientId": "1601185624273.8899143856786", "callbackPort": 3118 }
    }
  }
}
```

So the missing piece in pidex is a registered app, not code. Two ways to get
one, both a decision rather than a patch:

1. **pidex owns a Slack app**, published to the Marketplace so any workspace
   can authorize it (an internal app only works in the workspace that made
   it). Then the row hardcodes that id and port and becomes one click for
   everyone. Cost: Marketplace review, and pidex carries the rate-limit bucket.
2. **pidex hardcodes the published plugin id.** One line, works today. It also
   puts somebody else's app in front of the admin approving the integration,
   in the workspace audit log, and in the shared rate limit — the exact
   attribution Slack's App Identity rule exists to provide. Not taken.

Until one is chosen, the row asks for the id of an app the user controls, and
that is the honest state, not a defect.

## What changed here

Documentation and row copy only; no behaviour change.

- `src/features/connectors/catalog.ts` — the `preregistered` comment now
  records the partner-app reason and both one-click routes. The Slack caveat
  leads with "every MCP client hardcodes its own registered Slack app id,
  which is why Claude Desktop is one click", and the setup steps say an
  existing Slack app can be reused (add the redirect URL, enable PKCE, declare
  the scopes).
- `docs/mcp.md` — same reasoning, plus one correction: the page claimed
  `MCP_OAUTH_CALLBACK_PORT` overrides a connector's callback port. It does
  not. pidex writes `oauth.redirectUri` per server and the adapter prefers it,
  so the constant and the app manifest have to move together.

One aside worth remembering: Slack's own "Connect to Pi" instructions on that
page show `{"url": ..., "auth": "oauth"}` with no client id. That cannot work
— it sends the adapter to a `registration_endpoint` Slack does not publish.
