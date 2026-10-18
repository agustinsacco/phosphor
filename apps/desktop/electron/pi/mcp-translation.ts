import { isMcpExposure, type McpExposure, type McpScope, type McpServerConfig } from '@shared/mcp'
import { serverProblem } from './mcp-config'

export type Entry = Record<string, unknown>

export function isRecord(value: unknown): value is Entry {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const URL_FIELDS = [
  'url',
  'headers',
  'requestHeadersCommand',
  'caFile',
  'auth',
  'bearerToken',
  'bearerTokenEnv',
  'bearerTokenStore',
  'oauth',
  'httpTransport',
  'socket',
]
const COMMAND_FIELDS = ['command', 'args', 'env', 'cwd', 'inheritEnv', 'literalEnv', 'socket']
const URL_BOUND_FIELDS = [
  'headers',
  'bearerToken',
  'bearerTokenEnv',
  'bearerTokenStore',
  'requestHeadersCommand',
  'caFile',
  'auth',
  'oauth',
]

/**
 * The adapter's per-field merge (`mergeServerMaps`): a later entry overrides
 * fields, but switching transport drops the other transport's fields, and
 * pointing at a new URL drops credentials bound to the old one.
 */
export function mergeAdapterEntry(base: Entry | undefined, next: Entry): Entry {
  if (!base) return { ...next }
  const merged: Entry = { ...base }
  const drop = (fields: string[]): void => fields.forEach((field) => delete merged[field])
  if (typeof next.command === 'string') drop(URL_FIELDS)
  else if (typeof next.url === 'string') drop(COMMAND_FIELDS)
  if (typeof next.url === 'string' && next.url !== base.url) drop(URL_BOUND_FIELDS)
  return { ...merged, ...next }
}

/** Keys pi understands; they pass through translation untouched. */
const PI_KEYS = new Set([
  'type',
  'url',
  'headers',
  'command',
  'args',
  'env',
  'cwd',
  'exposure',
  'toolExposure',
  'enabled',
  'description',
  'timeout',
])
const PI_OAUTH_KEYS = new Set([
  'clientId',
  'clientSecret',
  'callbackPort',
  'callbackUrl',
  'scope',
  'clientName',
  'clientRegistration',
  'authServerMetadataUrl',
])
/** Adapter settings with no effect in pi; dropped without comment. */
export const SILENT_KEYS = new Set([
  'lifecycle',
  'idleTimeout',
  'toolPrefix',
  'debug',
  'trace',
  'openUi',
  'protocolVersion',
  'searchKeywords',
  'exposeResources',
  'httpTransport',
  'pluginDataDir',
])

function isLoopback(url: URL): boolean {
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
}

function translateAuthentication(
  entry: Entry,
  scope: McpScope,
  config: McpServerConfig,
  notes: string[],
): void {
  const headers: Record<string, string> = isRecord(entry.headers)
    ? ({ ...entry.headers } as Record<string, string>)
    : {}
  // Authentication. pi signs in with OAuth whenever an HTTP server without an
  // Authorization header asks for it, so `auth: "oauth"` needs no key.
  if (isRecord(entry.auth)) {
    if (scope === 'project')
      notes.push('Dropped auth.provider: pi allows it only in the global mcp.json.')
    else config.auth = entry.auth as { provider: string }
  }
  if (typeof entry.bearerToken === 'string') {
    headers.Authorization = `Bearer ${entry.bearerToken}`
    notes.push('The bearer token is now an Authorization header.')
  } else if (typeof entry.bearerTokenEnv === 'string') {
    headers.Authorization = `Bearer \${${entry.bearerTokenEnv}}`
    notes.push(
      `The bearer token is read from $${entry.bearerTokenEnv} through an Authorization header.`,
    )
  } else if (entry.bearerTokenStore === true) {
    notes.push(
      "The bearer token was in the adapter's credential store; add an Authorization header.",
    )
  }
  if (entry.requestHeadersCommand !== undefined) {
    notes.push('pi cannot run a command for request headers; set them under headers.')
  }
  if (typeof entry.caFile === 'string') {
    notes.push(
      `pi has no per-server CA file (${entry.caFile}); trust it with NODE_EXTRA_CA_CERTS instead.`,
    )
  }
  if (Object.keys(headers).length > 0) config.headers = headers
}

function translateOAuth(entry: Entry, config: McpServerConfig, notes: string[]): void {
  if (isRecord(entry.oauth)) {
    const oauth: Entry = {}
    for (const [key, value] of Object.entries(entry.oauth)) {
      if (PI_OAUTH_KEYS.has(key)) oauth[key] = value
      else if (key === 'redirectUri' && typeof value === 'string') {
        const uri = value.replace(':{port}', '')
        if (URL.canParse(uri) && isLoopback(new URL(uri))) oauth.callbackUrl = uri
        else notes.push(`pi needs a loopback redirect; ${value} was dropped.`)
      } else if (key === 'grantType' && value === 'client_credentials') {
        notes.push('pi has no client-credentials grant; this server signs in through the browser.')
      } else if (key !== 'grantType') {
        notes.push(`Dropped oauth.${key}, which pi does not support.`)
      }
    }
    if (Object.keys(oauth).length > 0) config.oauth = oauth
  }
}

function translateExposure(entry: Entry, config: McpServerConfig, notes: string[]): void {
  // How tools reach the model. The adapter's default — everything behind its
  // `mcp` proxy tool — is pi's default, codemode.
  const toolExposure: Record<string, McpExposure> = isRecord(entry.toolExposure)
    ? ({ ...entry.toolExposure } as Record<string, McpExposure>)
    : {}
  let exposure: McpExposure | undefined = isMcpExposure(entry.exposure) ? entry.exposure : undefined
  const direct = entry.directTools
  if (direct === true) exposure = 'direct'
  else if (direct === 'search') exposure = 'deferred'
  else if (Array.isArray(direct)) {
    for (const tool of direct) if (typeof tool === 'string') toolExposure[tool] = 'direct'
  }
  if (Array.isArray(entry.includeTools)) {
    const shown = exposure ?? 'codemode'
    for (const tool of entry.includeTools) {
      if (typeof tool === 'string' && toolExposure[tool] === undefined) toolExposure[tool] = shown
    }
    exposure = 'hidden'
  }
  if (Array.isArray(entry.excludeTools)) {
    for (const tool of entry.excludeTools)
      if (typeof tool === 'string') toolExposure[tool] = 'hidden'
  }
  if (entry.includeTools !== undefined || entry.excludeTools !== undefined) {
    notes.push("Tool filters became toolExposure rules; they match the server's own tool names.")
  }
  if (exposure !== undefined && exposure !== 'codemode') config.exposure = exposure
  else delete config.exposure
  if (Object.keys(toolExposure).length > 0) config.toolExposure = toolExposure
  else delete config.toolExposure
}

function addTranslationNotes(entry: Entry, notes: string[]): void {
  if (entry.approveTools !== undefined && entry.approveTools !== false) {
    notes.push('pi does not ask before MCP tool calls (approveTools was dropped).')
  }

  const handled = new Set([
    ...PI_KEYS,
    ...SILENT_KEYS,
    'auth',
    'bearerToken',
    'bearerTokenEnv',
    'bearerTokenStore',
    'requestHeadersCommand',
    'caFile',
    'oauth',
    'inheritEnv',
    'literalEnv',
    'disabled',
    'requestTimeoutMs',
    'directTools',
    'includeTools',
    'excludeTools',
    'approveTools',
  ])
  const unknown = Object.keys(entry).filter((key) => !handled.has(key))
  if (unknown.length > 0) notes.push(`Dropped ${unknown.join(', ')}, which pi does not read.`)
}

/** One merged adapter entry in pi's shape, or the reason it cannot move. */
export function translateEntry(
  name: string,
  entry: Entry,
  scope: McpScope,
): { config: McpServerConfig; notes: string[] } | { skip: string } {
  if (typeof entry.socket === 'string') {
    return {
      skip: 'pi cannot connect to an rmcp-mux socket; add the server again with a command or URL.',
    }
  }
  const notes: string[] = []
  const config: McpServerConfig = {}
  for (const [key, value] of Object.entries(entry)) {
    if (PI_KEYS.has(key) && key !== 'headers') config[key] = value
  }

  translateAuthentication(entry, scope, config, notes)
  translateOAuth(entry, config, notes)

  if (typeof entry.inheritEnv === 'boolean' && !entry.inheritEnv) {
    notes.push(
      'pi always passes its environment to a local server (inheritEnv: false was dropped).',
    )
  }
  if (entry.disabled === true) config.enabled = false
  if (typeof entry.requestTimeoutMs === 'number' && entry.requestTimeoutMs > 0) {
    config.timeout = Math.ceil(entry.requestTimeoutMs / 1000)
  }

  translateExposure(entry, config, notes)
  addTranslationNotes(entry, notes)

  const problem = serverProblem(name, config, scope)
  if (problem) return { skip: problem }
  return { config, notes }
}
