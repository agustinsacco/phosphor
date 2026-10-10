/**
 * MCP configuration model, mirroring the `pi-mcp-adapter` package's
 * documented config chain. pi core has no MCP support; the adapter reads
 * config files with this precedence (lowest → highest):
 *
 *   xdg        ~/.config/mcp/mcp.json
 *   agents     ~/.agents/mcp.json
 *   agents-dir ~/.agents/mcp/mcp.json
 *   pi-global  ~/.pi/agent/mcp-adapter.json      (honors PI_CODING_AGENT_DIR)
 *   project    <workspace>/.mcp.json
 *   pi-project <workspace>/.pi/mcp-adapter.json
 */
export const MCP_SCOPES = [
  'xdg',
  'agents',
  'agents-dir',
  'pi-global',
  'project',
  'pi-project',
] as const

export type McpScope = (typeof MCP_SCOPES)[number]

/** Scopes the UI offers for writes (the chain's global + project overrides). */
export type McpWriteScope = 'pi-global' | 'pi-project'

/** The adapter's `directTools` forms. */
export type McpDirectTools = string[] | boolean | 'search'

/**
 * What `directTools` puts in front of the model on every request, or null when
 * the server stays behind the `mcp` gateway (unset, `false`, `"search"`).
 */
export function directToolsSummary(value: unknown): string | null {
  if (value === true) return 'all tools'
  if (!Array.isArray(value)) return null
  const names = value.filter((name): name is string => typeof name === 'string' && name !== '')
  if (names.length === 0) return null
  return names.slice(0, 4).join(', ') + (names.length > 4 ? ` +${names.length - 4}` : '')
}

const DIRECT_TOOLS_KEYWORDS = new Set(['all', 'search'])

/**
 * The server editor's text for a `directTools` value. A list holding one tool
 * that happens to be named `all` or `search` gets a trailing comma, so saving
 * it again keeps a list instead of switching the server to that mode.
 */
export function directToolsText(value: unknown): string {
  if (value === true) return 'all'
  if (value === 'search') return 'search'
  if (!Array.isArray(value)) return ''
  const text = value.filter((name) => typeof name === 'string').join(', ')
  return DIRECT_TOOLS_KEYWORDS.has(text.trim().toLowerCase()) ? `${text},` : text
}

/**
 * The editor's text back to a `directTools` value; undefined means unset. Only
 * the bare words `all` and `search` are modes; any comma makes a tool list.
 */
export function parseDirectToolsText(text: string): McpDirectTools | undefined {
  const trimmed = text.trim()
  if (trimmed.toLowerCase() === 'all') return true
  if (trimmed.toLowerCase() === 'search') return 'search'
  const names = trimmed
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  return names.length > 0 ? names : undefined
}

/** One server entry as stored in adapter config (`mcpServers.<name>`). */
export interface McpServerConfig {
  /** Remote server URL (exactly one of url/command). */
  url?: string
  /** Local stdio server command (exactly one of url/command). */
  command?: string
  args?: string[]
  env?: Record<string, string>
  /**
   * Tools promoted to first-class pi tools instead of the lazy proxy: a list,
   * `true` for every tool, or `"search"` to load them through tool search.
   */
  directTools?: McpDirectTools
  /**
   * Adapter connection lifecycle. Defaults to `lazy` — connect on first tool
   * call, drop afterwards — which leaves an authenticated server reporting
   * `cached` between uses. `lazy-keep-alive` holds the connection open once
   * established, so it stays `connected`.
   */
  lifecycle?: 'keep-alive' | 'lazy' | 'lazy-keep-alive' | 'eager'
  disabled?: boolean
  [key: string]: unknown
}

/** A server after precedence resolution across the chain. */
export interface McpResolvedServer {
  name: string
  config: McpServerConfig
  /** Scope whose file won (defines the effective config). */
  scope: McpScope
  /** Lower-precedence scopes that also define this name. */
  shadows: McpScope[]
}

export interface McpFileState {
  scope: McpScope
  path: string
  exists: boolean
  malformed: boolean
  error?: string
  serverNames: string[]
}

export interface McpConfigsResult {
  /** Legacy pi files are not adapter config; never migrate them implicitly. */
  warnings?: string[]
  servers: McpResolvedServer[]
  files: McpFileState[]
}

/** Cached server metadata from the adapter's ~/.pi/agent/mcp-cache.json. */
export interface McpCacheEntry {
  name: string
  tools: McpCachedTool[]
}

/** One cached tool. The description is the server's own, capped for display. */
export interface McpCachedTool {
  name: string
  description?: string
}
