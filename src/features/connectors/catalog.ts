/**
 * The connector catalog: services pidex knows how to point the MCP adapter at
 * without the user typing a URL.
 *
 * Every entry here was checked against the vendor's own documentation. The
 * reason this is a curated list rather than free text is that the wrong URL
 * fails in a way that looks like broken auth: `mcp.notion.com/sse` is a real
 * endpoint that still resolves, and a legacy transport's failure surfaces as
 * "could not connect", not "you used the deprecated path".
 *
 * Auth is the adapter's job (OAuth 2.1 + PKCE + dynamic client registration,
 * tokens in the OS credential store). pidex only writes the config that lets
 * it work. See docs/specs/backlog/connectors.md.
 */
import type { McpServerConfig } from '@shared/mcp'

/**
 * How a connector authorizes.
 *
 * - `dcr` — the adapter registers itself dynamically. One click, no secrets.
 * - `preregistered` — the provider does NOT support dynamic registration, so
 *   the user creates an app up front and supplies its client id, and the
 *   redirect URI has to match byte for byte. Slack is the only one so far,
 *   and it is a *public* client: it only accepts a loopback redirect URL from
 *   an app with PKCE enabled, and a PKCE app's token exchange carries no
 *   secret. The secret field stays optional for that reason.
 *
 *   The client id is not a pidex shortcoming and cannot be designed away.
 *   Slack's own docs state it twice: "We do not support SSE-based connections
 *   or Dynamic Client Registration at this time", and "MCP clients must be
 *   backed by a registered Slack app with a fixed app ID and hardcode that
 *   app ID". Its authorization-server metadata carries no
 *   `registration_endpoint` to call even if we wanted to (re-probed
 *   2026-09-08).
 *
 *   Claude Desktop, Claude Code, Cursor and Perplexity are one click for the
 *   same reason they are named on Slack's "available clients" list: each one
 *   ships its OWN registered Slack app and hardcodes that app's id. Slack
 *   publishes Claude Code's outright — client id `1601185624273.8899143856786`
 *   on callback port 3118, in the plugin config on
 *   `docs.slack.dev/ai/slack-mcp-server/connect-to-harnesses`. So pidex could
 *   be one click two ways, and both are decisions rather than code: own a
 *   Marketplace-published Slack app (only internal or directory-published apps
 *   may use MCP at all), or hardcode somebody else's id — which would put
 *   their app, not pidex, in front of the admin approving it and in the audit
 *   log and rate-limit bucket recording it. Until then the row asks for the
 *   id of an app the user controls.
 * - `oauth-or-key` — OAuth works, and an API key is a supported alternative.
 */
export type ConnectorAuthKind = 'dcr' | 'preregistered' | 'oauth-or-key'

/**
 * What a `preregistered` connector needs done in the provider's console
 * before its row can do anything. Data, not markup: the tab renders it.
 */
export interface ConnectorSetup {
  steps: string[]
  /** Something to paste into the provider's console, verbatim. */
  snippet?: { label: string; text: string }
}

/** A regional/site variant of the same service, each with its own endpoint. */
export interface ConnectorVariant {
  id: string
  label: string
  url: string
}

export interface ConnectorEntry {
  id: string
  /** Display name. */
  name: string
  /** Default `mcpServers.<key>` name; also how a configured row is matched. */
  serverName: string
  summary: string
  authKind: ConnectorAuthKind
  docsUrl: string
  /** Single endpoint, for services with one. */
  url?: string
  /** Endpoint per region/site. Exactly one of `url` / `variants` is set. */
  variants?: { label: string; options: ConnectorVariant[] }
  /** A distinct read-only endpoint, offered as a checkbox when present. */
  readOnlyUrl?: string
  /**
   * Exact OAuth scope string, for providers whose default is wrong. With no
   * scope configured the MCP SDK asks for every scope in the server's
   * protected-resource metadata (`client/auth.js`: `scopes_supported.join`),
   * and a provider that only grants what the registered app declares rejects
   * the whole authorization over the difference — so Slack pins the same set
   * its manifest declares.
   */
  scope?: string
  /** Console steps the user must complete first (`preregistered` only). */
  setup?: ConnectorSetup
  /** The thing that will bite, shown in the row. */
  caveat?: string
}

/**
 * The adapter's OAuth callback, from its own defaults
 * (`mcp-oauth-provider.ts`: port 19876, path `/callback`). Only relevant for
 * `preregistered` connectors, where the provider requires the redirect URI to
 * be registered up front and match byte for byte.
 */
export const OAUTH_REDIRECT_URI = 'http://localhost:19876/callback'

/**
 * Slack's user-token scopes, verbatim from the server's own
 * `.well-known/oauth-protected-resource` (checked 2026-09-04). One list feeds
 * both the manifest the user pastes into Slack and the `oauth.scope` pidex
 * writes, because Slack fails the authorization if they disagree.
 */
export const SLACK_USER_SCOPES = [
  'canvases:read',
  'canvases:write',
  'channels:history',
  'channels:read',
  'channels:write',
  'chat:write',
  'emoji:read',
  'files:read',
  'files:write',
  'groups:history',
  'groups:read',
  'groups:write',
  'im:history',
  'im:read',
  'im:write',
  'lists:read',
  'lists:write',
  'mpim:history',
  'mpim:read',
  'mpim:write',
  'reactions:read',
  'reactions:write',
  'search:read.files',
  'search:read.im',
  'search:read.mpim',
  'search:read.private',
  'search:read.public',
  'search:read.users',
  'users:read',
  'users:read.email',
]

/**
 * An app manifest for Slack's "create from a manifest" flow, which sets the
 * scopes, the redirect URL and `pkce_enabled` in one paste. No bot user: a
 * desktop (loopback) redirect may not request bot scopes at all.
 */
export const SLACK_APP_MANIFEST = JSON.stringify(
  {
    display_information: { name: 'pidex MCP' },
    oauth_config: {
      redirect_urls: [OAUTH_REDIRECT_URI],
      scopes: { user: SLACK_USER_SCOPES },
      pkce_enabled: true,
    },
  },
  null,
  2,
)

/**
 * Every *read* scope Questrade's MCP server advertises, verbatim from
 * `https://mcp.questrade.com/.well-known/oauth-protected-resource` (checked
 * 2026-09-07), plus the two OIDC scopes the flow itself needs.
 *
 * Pinned rather than left to the default because the default is dangerous
 * here. With no `oauth.scope` the MCP SDK requests every scope in the
 * protected-resource metadata, and Questrade's list includes
 * `brokerage.orders.all` — so a one-click connect would hand an LLM authority
 * to place trades. Questrade's own setup guide makes the point that read-only
 * access can be granted without trade permissions; this is that choice, made
 * by default.
 *
 * `enterprise.balance-sheet.balance-sheet-app.read` is left out: it is an
 * enterprise entitlement a retail account cannot grant.
 */
export const QUESTRADE_READ_SCOPES = [
  'openid',
  'offline_access',
  'mcp:read',
  'brokerage.accounts.read',
  'brokerage.account-transactions.read',
  'brokerage.balances.all',
  'brokerage.charts.read',
  'brokerage.custom-indexing-indexes.read',
  'brokerage.custom-indexing-templates.read',
  'brokerage.orders.read',
  'brokerage.positions.read',
  'brokerage.securities.read',
  'brokerage.snap-quotes.read',
  'brokerage.watchlists.read',
]

/**
 * Questrade scopes pidex deliberately does not request. Named so a test can
 * assert none of them ever leaks into `QUESTRADE_READ_SCOPES` — the failure
 * mode is silent and expensive.
 *
 * `brokerage.balances.all` is NOT here: "all" means every balance type, not
 * write access. `brokerage.orders.all` is the one that authorizes trading.
 */
export const QUESTRADE_WRITE_SCOPES = [
  'mcp:write',
  'brokerage.orders.all',
  'brokerage.watchlists.write',
  'brokerage.custom-indexing-indexes.write',
]

export const CONNECTORS: ConnectorEntry[] = [
  {
    id: 'linear',
    name: 'Linear',
    serverName: 'linear',
    summary: 'Issues, projects, cycles and comments.',
    authKind: 'dcr',
    docsUrl: 'https://linear.app/docs/mcp',
    url: 'https://mcp.linear.app/mcp',
    readOnlyUrl: 'https://mcp.linear.app/mcp/readonly',
  },
  {
    id: 'notion',
    name: 'Notion',
    serverName: 'notion',
    summary: 'Read and update pages and databases you can already access.',
    authKind: 'dcr',
    docsUrl: 'https://developers.notion.com/guides/mcp/overview',
    url: 'https://mcp.notion.com/mcp',
  },
  {
    id: 'braintrust',
    name: 'Braintrust',
    serverName: 'braintrust',
    summary: 'Projects, experiments, datasets and logs.',
    authKind: 'oauth-or-key',
    docsUrl: 'https://www.braintrust.dev/docs/integrations/developer-tools/mcp',
    variants: {
      label: 'Data plane',
      options: [
        { id: 'us', label: 'US', url: 'https://api.braintrust.dev/mcp' },
        { id: 'eu', label: 'EU', url: 'https://api-eu.braintrust.dev/mcp' },
      ],
    },
    caveat: 'A Braintrust API key works instead of OAuth — see the MCP tab for bearer tokens.',
  },
  {
    id: 'datadog',
    name: 'Datadog',
    serverName: 'datadog',
    summary: 'Logs, metrics, traces, monitors and incidents.',
    authKind: 'dcr',
    docsUrl: 'https://docs.datadoghq.com/mcp_server/setup/',
    variants: {
      label: 'Datadog site',
      options: [
        { id: 'us1', label: 'US1', url: 'https://mcp.datadoghq.com/v1/mcp' },
        { id: 'us3', label: 'US3', url: 'https://mcp.us3.datadoghq.com/v1/mcp' },
        { id: 'us5', label: 'US5', url: 'https://mcp.us5.datadoghq.com/v1/mcp' },
        { id: 'eu1', label: 'EU1', url: 'https://mcp.datadoghq.eu/v1/mcp' },
        { id: 'uk1', label: 'UK1', url: 'https://mcp.uk1.datadoghq.com/v1/mcp' },
        { id: 'ap1', label: 'AP1', url: 'https://mcp.ap1.datadoghq.com/v1/mcp' },
        { id: 'ap2', label: 'AP2', url: 'https://mcp.ap2.datadoghq.com/v1/mcp' },
      ],
    },
    caveat:
      'The host is per site — the wrong one authorizes and then returns nothing. The default endpoint serves a subset of the tools: append ?toolsets=all for every tool, or ?toolsets=apm,llmobs for one product. GovCloud (ddog-gov.com) is not supported.',
  },
  {
    id: 'supabase',
    name: 'Supabase',
    serverName: 'supabase',
    summary: 'Projects, Postgres queries, edge functions, logs and docs.',
    authKind: 'dcr',
    docsUrl: 'https://supabase.com/docs/guides/getting-started/mcp',
    // Access is a query parameter, not a separate host, so it rides the
    // variant select — and read-only is first, which makes it the default.
    // `read_only=true` runs every query as a read-only Postgres user, which
    // is the only thing standing between a prompt injection and your data.
    variants: {
      label: 'Access',
      options: [
        { id: 'read-only', label: 'Read-only', url: 'https://mcp.supabase.com/mcp?read_only=true' },
        { id: 'read-write', label: 'Read + write', url: 'https://mcp.supabase.com/mcp' },
      ],
    },
    caveat:
      'Read-only runs every query as a read-only Postgres user. It does not narrow the OAuth grant: the token still carries write scopes, because Supabase advertises them all and the SDK asks for the advertised set. Without ?project_ref=<ref> the server reaches every project in the account — add one by editing the URL. Storage tools are opt-in via ?features=storage.',
  },
  {
    id: 'questrade',
    name: 'Questrade',
    serverName: 'questrade',
    summary: 'Brokerage accounts, positions, balances, orders, quotes and charts.',
    authKind: 'dcr',
    docsUrl: 'https://www.questrade.com/learning/using-questrade/connect-questrade-to-your-ai-tool',
    url: 'https://mcp.questrade.com/v1/brokerage/mcp',
    scope: QUESTRADE_READ_SCOPES.join(' '),
    caveat:
      'Read-only by default: pidex requests every read scope and no trading scope, so the model can see orders but not place them. Widen it under Advanced by editing oauth.scope if you actually want that. Registration hands every client the same shared public client id, so the app you approve in Questrade is not uniquely yours.',
  },
  {
    id: 'fellow',
    name: 'Fellow',
    serverName: 'fellow',
    summary: 'Meeting recaps, transcripts, action items and attendees.',
    authKind: 'dcr',
    docsUrl: 'https://help.fellow.ai/en/articles/12622641-fellow-s-mcp-server',
    url: 'https://fellow.app/mcp',
    caveat:
      'A workspace admin must first enable Security → Allow users to create MCP connections, or authorization fails.',
  },
  {
    id: 'slack',
    name: 'Slack',
    serverName: 'slack',
    summary: 'Channels, threads, messages and canvases.',
    authKind: 'preregistered',
    docsUrl: 'https://docs.slack.dev/ai/slack-mcp-server',
    url: 'https://mcp.slack.com/mcp',
    scope: SLACK_USER_SCOPES.join(' '),
    caveat: `Slack has no dynamic registration: every MCP client hardcodes its own registered Slack app id, which is why Claude Desktop is one click and this row asks for an id instead. Use an app you already registered, or create one below. Slack accepts ${OAUTH_REDIRECT_URI} as a redirect URL only from an app with PKCE enabled — which makes the app a public client, so the secret stays empty. Enabling PKCE cannot be undone without Slack support, and only internal or Marketplace-published apps may use MCP at all.`,
    setup: {
      steps: [
        'At api.slack.com/apps choose Create New App → From a manifest, and paste the manifest below. It sets the user scopes, the redirect URL and PKCE together.',
        `Already have a Slack app? Reuse it instead: add ${OAUTH_REDIRECT_URI} to OAuth & Permissions → Redirect URLs, turn on PKCE, and declare the user scopes from the manifest below — Slack fails the whole authorization for any scope the app does not declare.`,
        'Install the app to your workspace, then copy Basic Information → Client ID.',
        'Paste the client ID here and press Add — that writes the config and opens the browser to sign in. Leave the secret empty unless your app predates PKCE.',
      ],
      snippet: { label: 'Slack app manifest', text: SLACK_APP_MANIFEST },
    },
  },
]

/** What the user picked in a catalog row before pressing Add. */
export interface ConnectorChoice {
  /** Variant id, for connectors that have variants. */
  variant?: string
  readOnly?: boolean
  /** `preregistered` connectors only. Stored in mcp.json, so env refs are ok. */
  clientId?: string
  /** Optional: a PKCE app has no secret to give. */
  clientSecret?: string
}

/** Resolve the endpoint a choice points at. Throws on an unknown variant. */
export function connectorUrl(entry: ConnectorEntry, choice: ConnectorChoice = {}): string {
  if (choice.readOnly && entry.readOnlyUrl) return entry.readOnlyUrl
  if (!entry.variants) {
    if (!entry.url) throw new Error(`${entry.id} has neither url nor variants`)
    return entry.url
  }
  const id = choice.variant ?? entry.variants.options[0]?.id
  const option = entry.variants.options.find((o) => o.id === id)
  if (!option) throw new Error(`${entry.id} has no variant "${String(choice.variant)}"`)
  return option.url
}

/**
 * The mcp.json entry for a connector.
 *
 * `auth: "oauth"` is explicit rather than relying on the adapter's
 * auto-detection: auto-detect turns OAuth *off* the moment custom headers
 * exist, and a user adding a header later would silently lose authorization.
 */
export function buildConnectorConfig(
  entry: ConnectorEntry,
  choice: ConnectorChoice = {},
): McpServerConfig {
  // `lazy-keep-alive`, not the adapter's `lazy` default: lazy drops the
  // connection after every call, so a signed-in connector sits in `cached`
  // and the row reads as though the token were gone. Keeping it alive costs
  // one idle socket per server and is what people mean by "connected".
  const config: McpServerConfig = {
    url: connectorUrl(entry, choice),
    auth: 'oauth',
    lifecycle: 'lazy-keep-alive',
  }
  const oauth: Record<string, string> = {}
  if (entry.authKind === 'preregistered') {
    const clientId = choice.clientId?.trim()
    if (!clientId) throw new Error(`${entry.name} needs a client ID`)
    oauth.clientId = clientId
    // A PKCE app is a public client and its token exchange carries no secret;
    // writing an empty string would make the adapter pick client_secret_post.
    const clientSecret = choice.clientSecret?.trim()
    if (clientSecret) oauth.clientSecret = clientSecret
    oauth.redirectUri = OAUTH_REDIRECT_URI
  }
  if (entry.scope) oauth.scope = entry.scope
  if (Object.keys(oauth).length > 0) config.oauth = oauth
  return config
}

/**
 * Origin + path only: query strings and trailing slashes are configuration,
 * not identity. Datadog's caveat tells people to append `?toolsets=all` and
 * Supabase's own variants carry `?read_only=true`, so both sides of a
 * comparison have to be stripped — normalizing only the configured URL made a
 * catalog entry whose own URL had a query match nothing, which shows up as the
 * connector staying in "Add a connector" forever after it was added.
 */
function endpointIdentity(url: string): string {
  return url.split('?')[0]?.replace(/\/+$/, '') ?? ''
}

/**
 * Which catalog entry a configured server is, if any.
 *
 * Matched on the URL, not the name: a user may call it `linear-rw`, and the
 * endpoint is what actually decides who they are talking to.
 */
export function connectorForUrl(url: string | undefined): ConnectorEntry | undefined {
  if (!url) return undefined
  const normalized = endpointIdentity(url)
  return CONNECTORS.find((entry) => {
    const candidates = [
      entry.url,
      entry.readOnlyUrl,
      ...(entry.variants?.options.map((o) => o.url) ?? []),
    ]
    return candidates.some((candidate) => candidate && normalized === endpointIdentity(candidate))
  })
}
