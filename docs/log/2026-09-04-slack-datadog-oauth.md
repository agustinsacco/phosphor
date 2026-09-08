# Slack and Datadog connector OAuth, re-checked

_2026-09-04_

Both entries were written on 2026-08-27 from the vendors' docs. Re-checking
them against the servers' own OAuth metadata found the Slack row describing a
flow Slack does not allow, and the Datadog row missing two live sites.

## Slack was documented as a confidential client. It cannot be one.

The catalog demanded a client id **and** a client secret, and told the user to
register `http://localhost:19876/callback` as the app's redirect URL. Those two
instructions contradict each other:

- Slack rejects a `http://localhost` redirect URL from an ordinary app. It
  accepts one only from an app that has opted into **PKCE**, where a loopback
  URL counts as a "desktop redirect"
  ([Using PKCE](https://docs.slack.dev/authentication/using-pkce/)).
- Opting into PKCE makes the app a **public client**, and Slack's own flow says
  the token exchange must not carry `client_secret`.

So the required secret was both unobtainable and wrong. `buildConnectorConfig`
now needs the client id alone, and writes `clientSecret` only when one is
typed — an empty string would make the adapter choose `client_secret_post`
(`mcp-oauth-provider.ts: addClientAuthentication`). The auth kind is renamed
`confidential` → `preregistered`, which is what the category actually means:
the client is registered by hand, not that it holds a secret.

## Scopes were never requested, and the default is worse than none

With no `oauth.scope` configured, the MCP SDK asks for every scope in the
server's protected-resource metadata
(`@modelcontextprotocol/client`: `scopes_supported.join(" ")`). Slack advertises
30, and fails the whole authorization for any scope the registered app has not
declared — so the more scopes the user's app was missing, the more certainly
the flow died.

The fix is one list used twice. `SLACK_USER_SCOPES` (verbatim from
`https://mcp.slack.com/.well-known/oauth-protected-resource`) becomes
`oauth.scope`, and the same list becomes `SLACK_APP_MANIFEST` — an app manifest
the row offers to copy, which sets the scopes, the redirect URL and
`pkce_enabled` in one paste at `api.slack.com/apps`. A test asserts the two
cannot drift.

The row also now says the rule that fails last and reads as a Phosphor bug: only
**internal or Marketplace-published** apps may use the Slack MCP server at all.

## Datadog: right path, two missing sites

`/v1/mcp` is confirmed correct — `https://mcp.datadoghq.com/bogus/path` returns
404 while `/v1/mcp` returns 401. `authKind: 'dcr'` is confirmed too: the site's
`.well-known/oauth-authorization-server` advertises a `registration_endpoint`,
`pkce_required: true` and `token_endpoint_auth_methods_supported: ["none"]`.

Missing: **UK1** (`mcp.uk1.datadoghq.com`) and **AP2**
(`mcp.ap2.datadoghq.com`), both live and both listed as supported by
[Datadog's setup docs](https://docs.datadoghq.com/mcp_server/setup/). A user on
either site had no row to click. GovCloud stays out — Datadog does not support
it — and the caveat now says what `?toolsets=` is for: the default endpoint
serves a _subset_, and `?toolsets=all` is the widening knob, not just a
trimming one.

## Not changed

The other four endpoints were probed in the same pass (Linear, its read-only
path, Notion, Braintrust, Fellow). All answer 401 to an unauthenticated
`initialize`, which is the expected shape; none moved.
