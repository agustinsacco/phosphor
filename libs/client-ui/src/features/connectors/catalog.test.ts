import { describe, expect, it } from 'vitest'
import {
  CONNECTORS,
  GOOGLE_WORKSPACE_PRODUCTS,
  OAUTH_REDIRECT_URI,
  QUESTRADE_READ_SCOPES,
  QUESTRADE_WRITE_SCOPES,
  SLACK_APP_MANIFEST,
  SLACK_USER_SCOPES,
  buildConnectorConfig,
  connectorForUrl,
  connectorUrl,
} from './catalog'

describe('connector catalog', () => {
  it('points every endpoint at https streamable HTTP, never a legacy SSE path', () => {
    for (const entry of CONNECTORS) {
      const urls = [
        entry.url,
        entry.readOnlyUrl,
        ...(entry.variants?.options.map((o) => o.url) ?? []),
      ].filter((u): u is string => Boolean(u))
      expect(urls.length, entry.id).toBeGreaterThan(0)
      for (const url of urls) {
        expect(new URL(url).protocol, url).toBe('https:')
        // `/sse` still resolves at several vendors; its failures read as
        // broken auth rather than a deprecated transport.
        expect(url, url).not.toMatch(/\/sse\b/)
      }
    }
  })

  it('gives each entry exactly one endpoint source', () => {
    for (const entry of CONNECTORS) {
      expect(Boolean(entry.url) !== Boolean(entry.variants), entry.id).toBe(true)
    }
  })

  it('keeps ids, names and variant ids unique', () => {
    expect(new Set(CONNECTORS.map((c) => c.id)).size).toBe(CONNECTORS.length)
    expect(new Set(CONNECTORS.map((c) => c.serverName)).size).toBe(CONNECTORS.length)
    for (const entry of CONNECTORS) {
      const ids = entry.variants?.options.map((o) => o.id) ?? []
      expect(new Set(ids).size, entry.id).toBe(ids.length)
    }
  })

  it('defaults a variant connector to its first option', () => {
    const datadog = CONNECTORS.find((c) => c.id === 'datadog')!
    expect(connectorUrl(datadog)).toBe('https://mcp.datadoghq.com/v1/mcp')
    expect(connectorUrl(datadog, { variant: 'eu1' })).toBe('https://mcp.datadoghq.eu/v1/mcp')
  })

  it('refuses an unknown variant instead of silently using the default', () => {
    const datadog = CONNECTORS.find((c) => c.id === 'datadog')!
    expect(() => connectorUrl(datadog, { variant: 'us9' })).toThrow(/variant/)
  })

  it('swaps in the read-only endpoint only where one exists', () => {
    const linear = CONNECTORS.find((c) => c.id === 'linear')!
    expect(connectorUrl(linear, { readOnly: true })).toBe('https://mcp.linear.app/mcp/readonly')
    const notion = CONNECTORS.find((c) => c.id === 'notion')!
    expect(connectorUrl(notion, { readOnly: true })).toBe('https://mcp.notion.com/mcp')
  })

  it('writes only the URL for a dynamically registered connector — pi signs in on its own', () => {
    const notion = CONNECTORS.find((c) => c.id === 'notion')!
    expect(buildConnectorConfig(notion)).toEqual({ url: 'https://mcp.notion.com/mcp' })
  })

  it('writes a pre-registered client as a public PKCE client by default', () => {
    // Slack only accepts a loopback redirect URL from a PKCE app, and a PKCE
    // app's token exchange carries no secret. An empty secret must not reach
    // mcp.json, where it would still be sent as one.
    const slack = CONNECTORS.find((c) => c.id === 'slack')!
    expect(buildConnectorConfig(slack, { clientId: 'abc', clientSecret: '  ' })).toEqual({
      url: 'https://mcp.slack.com/mcp',
      oauth: {
        clientId: 'abc',
        callbackUrl: OAUTH_REDIRECT_URI,
        scope: SLACK_USER_SCOPES.join(' '),
      },
    })
  })

  it('keeps a client secret when a pre-PKCE app supplies one', () => {
    const slack = CONNECTORS.find((c) => c.id === 'slack')!
    const oauth = buildConnectorConfig(slack, { clientId: 'abc', clientSecret: 'shh' })
      .oauth as Record<string, string>
    expect(oauth.clientSecret).toBe('shh')
  })

  it('refuses to write a pre-registered connector with no client ID', () => {
    const slack = CONNECTORS.find((c) => c.id === 'slack')!
    expect(() => buildConnectorConfig(slack)).toThrow(/client ID/)
    expect(() => buildConnectorConfig(slack, { clientId: ' ', clientSecret: 'x' })).toThrow(
      /client ID/,
    )
  })

  it('asks Slack for exactly the scopes its own manifest declares', () => {
    // With no scope configured the MCP SDK requests every scope in the
    // server's protected-resource metadata, and Slack fails the whole
    // authorization for any scope the registered app does not declare.
    const manifest = JSON.parse(SLACK_APP_MANIFEST) as {
      oauth_config: { redirect_urls: string[]; pkce_enabled: boolean; scopes: { user: string[] } }
    }
    expect(manifest.oauth_config.scopes.user).toEqual(SLACK_USER_SCOPES)
    expect(manifest.oauth_config.redirect_urls).toEqual([OAUTH_REDIRECT_URI])
    expect(manifest.oauth_config.pkce_enabled).toBe(true)
  })

  it('recognises a configured server by endpoint, whatever it is named', () => {
    expect(connectorForUrl('https://mcp.linear.app/mcp/readonly')?.id).toBe('linear')
    expect(connectorForUrl('https://mcp.datadoghq.eu/v1/mcp?toolsets=apm')?.id).toBe('datadog')
    expect(connectorForUrl('https://mcp.notion.com/mcp/')?.id).toBe('notion')
    expect(connectorForUrl('https://mcp.example.com/mcp')).toBeUndefined()
    expect(connectorForUrl(undefined)).toBeUndefined()
  })

  it('matches a connector whose own catalog URL carries a query string', () => {
    // Supabase puts read-only in a query parameter, so the catalog side needs
    // the same normalization as the configured side. Without it the row stayed
    // in "Add a connector" after being added, and lost its summary.
    expect(connectorForUrl('https://mcp.supabase.com/mcp?read_only=true')?.id).toBe('supabase')
    expect(connectorForUrl('https://mcp.supabase.com/mcp')?.id).toBe('supabase')
    expect(connectorForUrl('https://mcp.supabase.com/mcp?project_ref=abc&read_only=true')?.id).toBe(
      'supabase',
    )
  })

  it('adds every configured connector back into the catalog exactly once', () => {
    // The tab hides a catalog entry once `connectorForUrl` claims one of its
    // endpoints, so an entry that cannot recognise its own URLs is a duplicate
    // row waiting to happen.
    for (const entry of CONNECTORS) {
      const urls = [
        entry.url,
        entry.readOnlyUrl,
        ...(entry.variants?.options.map((o) => o.url) ?? []),
      ].filter((u): u is string => Boolean(u))
      for (const url of urls) expect(connectorForUrl(url)?.id, url).toBe(entry.id)
    }
  })

  it('defaults Supabase to read-only, since the variant order is the default', () => {
    const supabase = CONNECTORS.find((c) => c.id === 'supabase')!
    expect(connectorUrl(supabase)).toBe('https://mcp.supabase.com/mcp?read_only=true')
    expect(connectorUrl(supabase, { variant: 'read-write' })).toBe('https://mcp.supabase.com/mcp')
  })

  it('writes a Google connector as a confidential client with its pinned scopes', () => {
    const gmail = CONNECTORS.find((c) => c.id === 'gmail')!
    expect(buildConnectorConfig(gmail, { clientId: 'id', clientSecret: 'shh' })).toEqual({
      url: 'https://gmailmcp.googleapis.com/mcp/v1',
      oauth: {
        clientId: 'id',
        clientSecret: 'shh',
        callbackUrl: OAUTH_REDIRECT_URI,
        scope:
          'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose',
      },
    })
    // Google's token exchange for a Web application client needs the secret.
    expect(() => buildConnectorConfig(gmail, { clientId: 'id', clientSecret: ' ' })).toThrow(
      /client secret/,
    )
  })

  it('never asks Google for full-mailbox, send or full-Drive access', () => {
    // With no `oauth.scope` the SDK requests every advertised scope, and
    // Gmail's server advertises `https://mail.google.com/` and `gmail.send`.
    const broad = [
      'https://mail.google.com/',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/calendar',
    ]
    expect(GOOGLE_WORKSPACE_PRODUCTS.length).toBeGreaterThan(0)
    for (const product of GOOGLE_WORKSPACE_PRODUCTS) {
      const entry = CONNECTORS.find((c) => c.id === product.id)!
      expect(entry.authKind, product.id).toBe('preregistered')
      expect(entry.secretRequired, product.id).toBe(true)
      const requested = (entry.scope ?? '').split(' ')
      expect(requested, product.id).toEqual(product.scopes)
      for (const scope of broad) expect(requested, product.id).not.toContain(scope)
    }
  })

  it('never asks Questrade for a scope that can move money', () => {
    // With no `oauth.scope` the MCP SDK requests every scope the server
    // advertises, and Questrade advertises `brokerage.orders.all`. A one-click
    // connect would hand an LLM the authority to place trades.
    const questrade = CONNECTORS.find((c) => c.id === 'questrade')!
    const requested = (questrade.scope ?? '').split(' ')
    expect(requested).toEqual(QUESTRADE_READ_SCOPES)
    for (const write of QUESTRADE_WRITE_SCOPES) {
      expect(requested, write).not.toContain(write)
      expect(QUESTRADE_READ_SCOPES, write).not.toContain(write)
    }
    // Refresh tokens and the id token are still needed for the flow itself.
    expect(requested).toContain('offline_access')
    expect(requested).toContain('mcp:read')
    // And the pin has to survive into mcp.json, or the default applies anyway.
    expect(buildConnectorConfig(questrade)).toEqual({
      url: 'https://mcp.questrade.com/v1/brokerage/mcp',
      oauth: { scope: QUESTRADE_READ_SCOPES.join(' ') },
    })
  })
})
