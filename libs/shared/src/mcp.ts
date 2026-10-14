/**
 * MCP configuration model, mirroring pi's built-in MCP support (pi ≥ 1.2.0).
 *
 * pi reads two files, both in the `mcpServers` shape other MCP clients use:
 *
 *   global   <agent dir>/mcp.json        (honors PI_CODING_AGENT_DIR)
 *   project  <workspace>/.pi/mcp.json    (only when pi trusts the project)
 *
 * A project entry replaces a global entry with the same name. A project entry
 * without `command`, `url` or `type` is an override: it changes only
 * `enabled`, `exposure` and `toolExposure` of the global server it names.
 */
export const MCP_SCOPES = ['global', 'project'] as const

export type McpScope = (typeof MCP_SCOPES)[number]

/**
 * How a server's tools reach the model (pi's `McpExposure`):
 * - `codemode` (default): callable from codemode scripts, which find them by search.
 * - `deferred`: declared once `tool_search` loads them, then called directly.
 * - `direct`: declared to the model on every request, like a built-in tool.
 * - `hidden`: registered but unreachable.
 */
export const MCP_EXPOSURES = ['codemode', 'deferred', 'direct', 'hidden'] as const

export type McpExposure = (typeof MCP_EXPOSURES)[number]

export function isMcpExposure(value: unknown): value is McpExposure {
  return typeof value === 'string' && (MCP_EXPOSURES as readonly string[]).includes(value)
}

/** pi's rule for server names. Anything else fails validation and never loads. */
export const MCP_SERVER_NAME = /^[A-Za-z0-9_-]+$/

/** The namespace of a server's tools: `mcp__<server>`, `-` turned into `_`. */
export function mcpNamespace(server: string): string {
  return `mcp__${server.replace(/-/g, '_')}`
}

/** OAuth client settings, for servers without dynamic client registration. */
export interface McpOAuthConfig {
  clientId?: string
  clientSecret?: string
  callbackPort?: number
  /** Loopback redirect URI registered for `clientId`. */
  callbackUrl?: string
  scope?: string
  clientName?: string
  clientRegistration?: 'dcr' | 'cimd'
  authServerMetadataUrl?: string
}

/** One `mcpServers.<name>` entry, as pi reads it. Unknown keys are kept on writes. */
export interface McpServerConfig {
  type?: 'stdio' | 'http' | 'streamable-http'
  /** Streamable HTTP endpoint (exactly one of url/command). */
  url?: string
  headers?: Record<string, string>
  oauth?: McpOAuthConfig
  /** Send a pi `/login` provider's token instead of OAuth. Global file only. */
  auth?: { provider: string }
  /** Local stdio server command (exactly one of url/command). */
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  /** Default `codemode`. */
  exposure?: McpExposure
  /** Per-tool exposure; keys are the server's own tool names or `*` patterns. */
  toolExposure?: Record<string, McpExposure>
  /** `false` keeps the entry without connecting. Default true. */
  enabled?: boolean
  description?: string
  /** Per-request timeout, seconds. */
  timeout?: number
  [key: string]: unknown
}

/** Whether an entry only overrides a global server (pi's `isOverride`). */
export function isMcpOverride(config: McpServerConfig): boolean {
  return config.command === undefined && config.url === undefined && config.type === undefined
}

/** A server after pi's resolution of the two files. */
export interface McpResolvedServer {
  name: string
  /** The effective config: a project override is already applied. */
  config: McpServerConfig
  /** The entry as written in its own file — what an edit starts from. */
  defined: McpServerConfig
  /** The file that defines the server. */
  scope: McpScope
  /**
   * The project file overrides this global server's enabled/exposure/toolExposure,
   * so those are decided there.
   */
  overridden?: boolean
  /** A project definition replaces a global one with the same name. */
  replacesGlobal?: boolean
}

export interface McpFileState {
  scope: McpScope
  path: string
  exists: boolean
  malformed: boolean
  error?: string
  serverNames: string[]
}

/** Whether pi will read the workspace's `.pi/mcp.json`. */
export interface McpProjectTrust {
  /** Canonical folder pi checks. */
  path: string
  trusted: boolean
  /** Where the answer comes from: an entry in pi's trust store, or its default. */
  source: 'trust-store' | 'default'
}

export interface McpConfigsResult {
  servers: McpResolvedServer[]
  files: McpFileState[]
  /** Entries pi rejects, with the reason — they never load. */
  errors: string[]
  /** Null without a workspace. */
  projectTrust: McpProjectTrust | null
  /** pi-mcp-adapter config is still present: Settings offers the migration. */
  legacy: boolean
}

/** The exposure badge for a server, or null at pi's default (codemode, no per-tool changes). */
export function exposureSummary(config: McpServerConfig): string | null {
  const exposure = isMcpExposure(config.exposure) ? config.exposure : 'codemode'
  const overrides = Object.keys(config.toolExposure ?? {}).length
  if (exposure === 'codemode' && overrides === 0) return null
  const tools = overrides > 0 ? ` +${String(overrides)} tool rule${overrides === 1 ? '' : 's'}` : ''
  return `${exposure}${tools}`
}

/** Whether any of a server's tools cost their full schema on every request. */
export function exposesDirectTools(config: McpServerConfig): boolean {
  if (config.exposure === 'direct') return true
  return Object.values(config.toolExposure ?? {}).includes('direct')
}

// ---------- `pi mcp list --json` ----------

/** pi's connection states; `disabled` for a server that is turned off. */
export type McpServerState =
  'connected' | 'needs-auth' | 'failed' | 'disconnected' | 'connecting' | 'closed' | 'disabled'

/** One server in `pi mcp list --json`. */
export interface McpServerReport {
  name: string
  scope: string
  source: string
  override?: string
  enabled: boolean
  exposure: string
  transport: string
  state: McpServerState
  /** The server's own tool names, in its order. */
  tools: string[]
  error?: string
}

/** A finished `pi mcp list`. `note` is pi's word on an untrusted project file. */
export type McpListResult =
  | { ok: true; servers: McpServerReport[]; errors: string[]; note?: string }
  | { ok: false; message: string }

// ---------- pi-mcp-adapter migration ----------

/** One server the migration writes. */
export interface McpMigrationServer {
  name: string
  scope: McpScope
  /** The adapter-side files that defined it, lowest precedence first. */
  sources: string[]
  config: McpServerConfig
  /** What changed in translation, for the preview. */
  notes: string[]
}

export interface McpMigrationPlan {
  servers: McpMigrationServer[]
  /** Entries that cannot move, with the reason. */
  skipped: Array<{ name: string; source: string; reason: string }>
  /** Adapter-owned files the migration renames to a `.migrated-<time>` backup. */
  retire: string[]
  /** pi's user settings turn the built-in MCP off (`-builtin:mcp`); the migration removes that. */
  builtinDisabled: boolean
  /** Unreadable sources; the migration refuses to run until they are fixed. */
  blocked: string[]
}

export interface McpMigrationResult {
  written: string[]
  /** Backups made, old path → backup path. */
  backups: Array<{ from: string; to: string }>
}
