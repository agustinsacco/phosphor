# Add starts the sign-in, plus Supabase and Questrade

_2026-09-07_

The report was "Slack still asks for a client id, it should spawn the OAuth
flow with the browser instead". Half of that is not fixable and half of it was
a real defect in every row, not just Slack's.

## Slack's client id is required. Slack says so twice.

Re-probed today:

- `https://mcp.slack.com/.well-known/oauth-authorization-server` returns
  `authorization_endpoint`, `token_endpoint`, `code_challenge_methods_supported:
["S256"]` — and **no `registration_endpoint`**. There is nothing to call.
- [Slack's MCP docs](https://docs.slack.dev/ai/slack-mcp-server) state it in
  prose: "We do not support SSE-based connections or Dynamic Client
  Registration at this time", and under **App Identity**, "MCP clients must be
  backed by a registered Slack app with a fixed app ID and hardcode that app
  ID". Plus "Only directory-published apps or internal apps may use MCP."

So a one-click Slack row is only reachable if pidex registers its own Slack app
and gets it published to the Marketplace. Until then the client-id field stays.
What changed is honesty about it: the Add button is now disabled until a client
id is typed, instead of letting `buildConnectorConfig` throw
"Slack needs a client ID" into the error banner after the click.

## The real defect: Add wrote a config file and stopped there

Every catalog row's Add called `mcp:upsertServer` and nothing else. The
connector moved into Connected, where it needed a _separate_ Sign in click to
open a browser. Nobody reads that as two steps — they read it as Add having
done nothing, and Slack is where it stings, because you have just pasted a
client id and are watching for a browser.

Add now runs the headless flow itself, so the row lands in Connected with its
flow card open and the browser already launched.

Headless deliberately, even with a session open. A live session's adapter read
`mcp.json` when it started, so it has never heard of the server we just wrote
and would refuse `/mcp-auth` for it. `mcp:authorize`'s handler is already
`void startConnectorAuth(...)`, so the invoke returns immediately and the
`refresh()` that moves the row still happens at once.

## Two new connectors, both with dynamic registration

Both endpoints were found from the resource metadata rather than a docs page,
and both registration endpoints were exercised for real:

|           | endpoint                                     | DCR probe                                                          |
| --------- | -------------------------------------------- | ------------------------------------------------------------------ |
| Supabase  | `https://mcp.supabase.com/mcp`               | `POST https://api.supabase.com/platform/oauth/apps/register` → 201 |
| Questrade | `https://mcp.questrade.com/v1/brokerage/mcp` | `POST https://mcp.questrade.com/connect/register` → 201            |

Questrade's registration is dynamic in shape only: it echoes the submitted
`redirect_uris` back with a **fixed** `client_id: "claude-code-public"`. It is a
shared public client, which is worth knowing before wondering why the app you
approved in Questrade is not named after you. The row says so.

### Both default to read-only, and for different mechanisms

The dangerous default here is the _absence_ of a setting. With no `oauth.scope`
the MCP SDK asks for every scope in the protected-resource metadata, and
Questrade's list contains `brokerage.orders.all`. One click would have handed a
model authority to place trades.

- **Questrade** pins `QUESTRADE_READ_SCOPES` — every read scope the server
  advertises, no write scope. `QUESTRADE_WRITE_SCOPES` exists only to name what
  was excluded, so a test can assert none of it drifts back in.
  `brokerage.balances.all` is _not_ a write scope; "all" means every balance
  type. `enterprise.balance-sheet.balance-sheet-app.read` is left out as an
  entitlement a retail account cannot grant.
- **Supabase** has no useful scope knob — it advertises its write scopes and the
  SDK asks for the advertised set — so its control is the query parameter
  `read_only=true`, which runs every query as a read-only Postgres user. That
  is expressed as the _first_ variant, which is what makes it the default. The
  caveat is explicit that this constrains the SQL user and not the grant, and
  that without `?project_ref=<ref>` the server reaches every project in the
  account.

## `connectorForUrl` could not match a catalog URL with a query string

Supabase's read-only variant is `…/mcp?read_only=true`, which surfaced a latent
bug: the matcher stripped the query from the _configured_ URL but compared it
against catalog candidates verbatim. Any catalog entry whose own URL carried a
query would match nothing — the connector would stay in "Add a connector" after
being added, and its configured row would lose its summary. Both sides now go
through `endpointIdentity`, and a test walks every catalog URL back through
`connectorForUrl`.

## Known gap, not fixed here

`stores/connectors.ts` calls `mcp:authorize` without a workspace path, so the
headless flow always runs with `homedir()` as cwd. A connector defined only in
a project-scope `.pi/mcp.json` therefore cannot be authorized from the row.
Adds always write `pi-global`, so this change does not touch it.
