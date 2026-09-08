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

So the missing piece in pidex is a registered app, not code. Three ways to get
one, and the ordering is not the obvious one.

1. **An internal app, per user.** What the row does today. Create from the
   manifest at `api.slack.com/apps`, install to the workspace, paste the client
   id: a one-time errand of a couple of minutes, no review, and every connect
   after it is the same browser flow as any other connector. Internal apps are
   explicitly allowed to use MCP. The app only exists in the workspace that
   made it, so each user does their own.
2. **pidex owns a Marketplace-published app.** This is the one that sounds
   right and is effectively closed. Slack requires a submission to have **at
   least 10 installations on active workspaces before review starts**, held
   for the whole review ([changelog, 2026-09-01](https://docs.slack.dev/changelog/2026/09/01/slack-marketplace-install-requirement));
   preliminary review runs up to 10 business days and functional review **up
   to 10 weeks**. The guidelines also refuse apps that "do not include
   functionality in Slack", that "replicate Slack client functionality", and
   that "unnecessarily request a large number of scopes" — a desktop MCP
   reader asking for all 30 user scopes is three for three. Claude and Cursor
   cleared this as Slack partners at scale; pidex would not.
3. **pidex hardcodes the published Claude plugin id.** One line, works today,
   and in a workspace that already approved the Claude app it needs no admin
   request at all. It also puts somebody else's app in front of the admin
   approving the integration, in the workspace audit log, and in the shared
   rate limit — the exact attribution Slack's App Identity rule exists to
   provide. Not taken.

So the row asking for the id of an app the user controls is the design, not a
placeholder for a one-click version that is coming.

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
