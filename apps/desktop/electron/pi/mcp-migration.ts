import { copyFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  isMcpExposure,
  isMcpOverride,
  mcpNamespace,
  type McpExposure,
  type McpMigrationPlan,
  type McpMigrationResult,
  type McpScope,
  type McpServerConfig,
} from '@shared/mcp'
import { readJsonFile } from '@phosphor/session-runtime/pi/json-config'
import { disablesBuiltinMcp, mcpDirs, serverProblem, type McpDirs } from './mcp-config'

/**
 * Moving MCP servers from pi-mcp-adapter to pi's built-in MCP support.
 *
 * The adapter read a chain of files and merged entries field by field; pi
 * reads two files and replaces whole entries. So the migration replays the
 * adapter's merge to get the config each server actually ran with, translates
 * that into pi's shape, and writes it to pi's own file for the same scope.
 * pi's own `mcp.json` was one of the adapter's files (once its main one), so
 * its entries are translated too; one already in pi's shape is left alone.
 *
 * Only scopes the adapter was running are planned: one with its own file, and
 * every scope while it had pi's MCP turned off. Once moved, a later run (a
 * project that still has an adapter file) leaves global config alone, rather
 * than merging the shared files into it again.
 *
 * Nothing is deleted. Target files are backed up before they are written, the
 * adapter's own files are renamed out of the way, and files shared with other
 * MCP clients (`~/.config/mcp/mcp.json`, `.mcp.json`, …) are only read.
 * Credentials do not move: the adapter kept tokens in the OS credential
 * store, pi keeps them in its agent dir, so OAuth servers sign in again.
 */

interface Source {
  path: string
  scope: McpScope
  /** The adapter's own file, renamed once migrated. */
  owned: boolean
  /** pi's file for this scope: read by both, and the migration's target. */
  target: boolean
}

/** The adapter's chain, lowest precedence first (its docs/configuration.md). */
export function adapterSources(workspacePath: string | undefined, dirs: McpDirs): Source[] {
  const sources: Source[] = [
    { path: join(dirs.xdgConfig, 'mcp', 'mcp.json'), scope: 'global', owned: false, target: false },
    { path: join(dirs.home, '.agents', 'mcp.json'), scope: 'global', owned: false, target: false },
    {
      path: join(dirs.home, '.agents', 'mcp', 'mcp.json'),
      scope: 'global',
      owned: false,
      target: false,
    },
    { path: join(dirs.piAgent, 'mcp.json'), scope: 'global', owned: false, target: true },
    { path: join(dirs.piAgent, 'mcp-adapter.json'), scope: 'global', owned: true, target: false },
  ]
  if (workspacePath) {
    sources.push(
      { path: join(workspacePath, '.mcp.json'), scope: 'project', owned: false, target: false },
      {
        path: join(workspacePath, '.pi', 'mcp.json'),
        scope: 'project',
        owned: false,
        target: true,
      },
      {
        path: join(workspacePath, '.pi', 'mcp-adapter.json'),
        scope: 'project',
        owned: true,
        target: false,
      },
    )
  }
  return sources
}

type Entry = Record<string, unknown>

function isRecord(value: unknown): value is Entry {
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
const SILENT_KEYS = new Set([
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
  const headers: Record<string, string> = isRecord(entry.headers)
    ? ({ ...entry.headers } as Record<string, string>)
    : {}
  for (const [key, value] of Object.entries(entry)) {
    if (PI_KEYS.has(key) && key !== 'headers') config[key] = value
  }

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

  if (typeof entry.inheritEnv === 'boolean' && !entry.inheritEnv) {
    notes.push(
      'pi always passes its environment to a local server (inheritEnv: false was dropped).',
    )
  }
  if (entry.disabled === true) config.enabled = false
  if (typeof entry.requestTimeoutMs === 'number' && entry.requestTimeoutMs > 0) {
    config.timeout = Math.ceil(entry.requestTimeoutMs / 1000)
  }

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

  const problem = serverProblem(name, config, scope)
  if (problem) return { skip: problem }
  return { config, notes }
}

export interface ReadSource extends Source {
  exists: boolean
  malformed: boolean
  raw: Entry
}

/** The plan, from sources already read. Pure, so every rule is testable. */
export function buildPlan(sources: ReadSource[], settings: unknown): McpMigrationPlan {
  const plan: McpMigrationPlan = {
    servers: [],
    skipped: [],
    retire: sources.filter((s) => s.owned && s.exists).map((s) => s.path),
    builtinDisabled: disablesBuiltinMcp(settings),
    blocked: sources.filter((s) => s.malformed).map((s) => s.path),
  }
  const owns = (scope: McpScope): boolean =>
    sources.some((s) => s.scope === scope && s.owned && s.exists)
  const adapterRan = {
    global: owns('global') || plan.builtinDisabled,
    project: owns('global') || plan.builtinDisabled || owns('project'),
  }
  const names = new Set<string>()
  for (const scope of ['global', 'project'] as const) {
    if (!adapterRan[scope]) continue
    const merged = new Map<string, { entry: Entry; sources: string[]; piOnly: boolean }>()
    for (const source of sources.filter((s) => s.scope === scope && s.exists)) {
      const servers = isRecord(source.raw.mcpServers) ? source.raw.mcpServers : {}
      for (const [name, value] of Object.entries(servers)) {
        if (!isRecord(value)) continue
        const previous = merged.get(name)
        merged.set(name, {
          entry: mergeAdapterEntry(previous?.entry, value),
          sources: [...(previous?.sources ?? []), source.path],
          piOnly: (previous?.piOnly ?? true) && source.target,
        })
      }
      if (source.owned && Array.isArray(source.raw.imports) && source.raw.imports.length > 0) {
        plan.skipped.push({
          name: `imports: ${source.raw.imports.join(', ')}`,
          source: source.path,
          reason: 'Servers imported from other apps are not copied; add them in Settings.',
        })
      }
    }
    for (const [name, { entry, sources: from, piOnly }] of merged) {
      const source = from[from.length - 1]!
      const translated =
        isMcpOverride(entry as McpServerConfig) && entry.socket === undefined
          ? translatePartial(entry, scope)
          : translateEntry(name, entry, scope)
      // Only in pi's file, and already in pi's shape: nothing to move.
      if (piOnly && 'config' in translated && isDeepStrictEqual(translated.config, entry)) {
        names.add(name)
        continue
      }
      if ('skip' in translated) {
        plan.skipped.push({ name, source, reason: translated.skip })
        continue
      }
      const clash = [...names].find(
        (other) => other !== name && mcpNamespace(other) === mcpNamespace(name),
      )
      if (clash) {
        plan.skipped.push({ name, source, reason: `Its tool names would collide with "${clash}".` })
        continue
      }
      names.add(name)
      plan.servers.push({
        name,
        scope,
        sources: from,
        config: translated.config,
        notes: translated.notes,
      })
    }
  }
  return plan
}

/**
 * An entry with no command or url only adjusted a server defined in a lower
 * file. pi allows that in the project file alone, as an override of
 * `enabled`, `exposure` and `toolExposure`.
 */
function translatePartial(
  entry: Entry,
  scope: McpScope,
): { config: McpServerConfig; notes: string[] } | { skip: string } {
  if (scope === 'global') return { skip: 'It has no command or url.' }
  const config: McpServerConfig = {}
  if (typeof entry.enabled === 'boolean') config.enabled = entry.enabled
  if (typeof entry.disabled === 'boolean') config.enabled = !entry.disabled
  if (isMcpExposure(entry.exposure)) config.exposure = entry.exposure
  if (entry.directTools === true) config.exposure = 'direct'
  else if (entry.directTools === 'search') config.exposure = 'deferred'
  else if (Array.isArray(entry.directTools)) {
    config.toolExposure = Object.fromEntries(
      entry.directTools.filter((t): t is string => typeof t === 'string').map((t) => [t, 'direct']),
    )
  }
  if (isRecord(entry.toolExposure)) {
    config.toolExposure = {
      ...(entry.toolExposure as Record<string, McpExposure>),
      ...config.toolExposure,
    }
  }
  const used = new Set([
    'enabled',
    'disabled',
    'exposure',
    'directTools',
    'toolExposure',
    ...SILENT_KEYS,
  ])
  const dropped = Object.keys(entry).filter((key) => !used.has(key))
  if (Object.keys(config).length === 0)
    return { skip: 'It only changed settings pi does not have.' }
  const notes =
    dropped.length > 0
      ? [`A project override can only change enabled and exposure; dropped ${dropped.join(', ')}.`]
      : []
  return { config, notes }
}

async function readSources(
  workspacePath: string | undefined,
  dirs: McpDirs,
): Promise<ReadSource[]> {
  return Promise.all(
    adapterSources(workspacePath, dirs).map(async (source) => {
      const read = await readJsonFile(source.path)
      const malformed = read.malformed || (read.exists && !isRecord(read.value))
      return { ...source, exists: read.exists, malformed, raw: malformed ? {} : read.value }
    }),
  )
}

export async function planMcpMigration(
  workspacePath: string | undefined,
  dirs: McpDirs = mcpDirs(),
): Promise<McpMigrationPlan> {
  const settings = await readJsonFile(join(dirs.piAgent, 'settings.json'))
  const plan = buildPlan(await readSources(workspacePath, dirs), settings.value)
  if (settings.malformed) plan.blocked.push(join(dirs.piAgent, 'settings.json'))
  return plan
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-')
}

/**
 * Run the migration: write pi's files, rename the adapter's, and turn pi's
 * built-in MCP back on. The plan is recomputed here rather than taken from the
 * renderer, so a file edited since the preview cannot be overwritten blind.
 */
export async function runMcpMigration(
  workspacePath: string | undefined,
  dirs: McpDirs = mcpDirs(),
  now = new Date(),
): Promise<McpMigrationResult> {
  const sources = await readSources(workspacePath, dirs)
  const settingsPath = join(dirs.piAgent, 'settings.json')
  const settings = await readJsonFile(settingsPath)
  const plan = buildPlan(sources, settings.value)
  if (settings.malformed) plan.blocked.push(settingsPath)
  if (plan.blocked.length > 0) {
    throw new Error(`Fix these files first, they are not valid JSON: ${plan.blocked.join(', ')}`)
  }

  const suffix = stamp(now)
  const result: McpMigrationResult = { written: [], backups: [] }
  const backup = async (path: string, move: boolean): Promise<void> => {
    const to = `${path}.${move ? 'migrated' : 'bak'}-${suffix}`
    await (move ? rename(path, to) : copyFile(path, to))
    result.backups.push({ from: path, to })
  }

  for (const target of sources.filter((s) => s.target)) {
    const servers = plan.servers.filter((s) => s.scope === target.scope)
    if (servers.length === 0) continue
    const raw: Entry = { ...target.raw }
    const mcpServers: Entry = isRecord(raw.mcpServers) ? { ...raw.mcpServers } : {}
    for (const server of servers) mcpServers[server.name] = server.config
    raw.mcpServers = mcpServers
    if (target.exists) await backup(target.path, false)
    await mkdir(dirname(target.path), { recursive: true })
    await writeFile(target.path, JSON.stringify(raw, null, 2) + '\n', 'utf8')
    result.written.push(target.path)
  }

  for (const path of plan.retire) await backup(path, true)

  if (plan.builtinDisabled && isRecord(settings.value)) {
    const extensions = settings.value.extensions as unknown[]
    const next = {
      ...settings.value,
      extensions: extensions.filter(
        (entry) => entry !== '-builtin:mcp' && entry !== '!builtin:mcp',
      ),
    }
    await backup(settingsPath, false)
    await writeFile(settingsPath, JSON.stringify(next, null, 2) + '\n', 'utf8')
    result.written.push(settingsPath)
  }
  return result
}
