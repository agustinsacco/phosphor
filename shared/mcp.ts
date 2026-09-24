/**
 * MCP configuration model, mirroring the `pi-mcp-adapter` package's
 * documented config chain. pi core has no MCP support; the adapter reads
 * `mcp.json` files with this precedence (lowest → highest):
 *
 *   xdg        ~/.config/mcp/mcp.json
 *   agents     ~/.agents/mcp.json
 *   agents-dir ~/.agents/mcp/mcp.json
 *   pi-global  ~/.pi/agent/mcp.json      (honors PI_CODING_AGENT_DIR)
 *   project    <workspace>/.mcp.json
 *   pi-project <workspace>/.pi/mcp.json
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

/** One server entry as stored in mcp.json (`mcpServers.<name>`). */
export interface McpServerConfig {
  /** Remote server URL (exactly one of url/command). */
  url?: string
  /** Local stdio server command (exactly one of url/command). */
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** Tools promoted to first-class pi tools instead of the lazy proxy. */
  directTools?: string[]
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
