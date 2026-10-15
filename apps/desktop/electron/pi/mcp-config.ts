import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  MCP_SERVER_NAME,
  isMcpOverride,
  mcpNamespace,
  type McpConfigsResult,
  type McpFileState,
  type McpProjectTrust,
  type McpResolvedServer,
  type McpScope,
  type McpServerConfig,
} from '@shared/mcp'
import { piAgentDir } from './pi-paths'
import { readJsonFile } from '@phosphor/session-runtime/pi/json-config'

/**
 * Configuration management for pi's built-in MCP support (see shared/mcp.ts
 * for the two files and how pi resolves them). The renderer only ever names a
 * scope — paths are resolved here, in the main process.
 */

export interface McpDirs {
  home: string
  xdgConfig: string
  piAgent: string
}

/** Where this user's MCP-related files live. Home and XDG matter only to the migration. */
export function mcpDirs(): McpDirs {
  return {
    home: homedir(),
    xdgConfig: process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
    piAgent: piAgentDir(),
  }
}

/** pi's two files, global first. Dirs injectable for tests. */
export function mcpConfigPaths(
  workspacePath: string | undefined,
  dirs: McpDirs = mcpDirs(),
): Array<{ scope: McpScope; path: string }> {
  const paths: Array<{ scope: McpScope; path: string }> = [
    { scope: 'global', path: join(dirs.piAgent, 'mcp.json') },
  ]
  if (workspacePath) paths.push({ scope: 'project', path: join(workspacePath, '.pi', 'mcp.json') })
  return paths
}

/** The files pi-mcp-adapter owns. Their presence is what calls for the migration. */
export function adapterConfigPaths(workspacePath: string | undefined, dirs: McpDirs): string[] {
  const paths = [join(dirs.piAgent, 'mcp-adapter.json')]
  if (workspacePath) paths.push(join(workspacePath, '.pi', 'mcp-adapter.json'))
  return paths
}

interface ParsedFile {
  state: McpFileState
  servers: Record<string, McpServerConfig>
  /** Full parsed object, preserved verbatim on writes. */
  raw: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readMcpFileAt(scope: McpScope, path: string): Promise<ParsedFile> {
  const base = { scope, path, exists: false, malformed: false }
  const read = await readJsonFile(path)
  const malformed = (error: string): ParsedFile => ({
    state: { ...base, exists: true, malformed: true, error, serverNames: [] },
    servers: {},
    raw: {},
  })
  if (read.malformed) return malformed(read.error ?? 'parse error')
  if (!read.exists) return { state: { ...base, serverNames: [] }, servers: {}, raw: {} }
  if (
    !isRecord(read.value) ||
    (read.value.mcpServers !== undefined && !isRecord(read.value.mcpServers))
  ) {
    return malformed('expected an object with an "mcpServers" object')
  }
  const servers = (read.value.mcpServers ?? {}) as Record<string, McpServerConfig>
  return {
    state: { ...base, exists: true, serverNames: Object.keys(servers) },
    servers,
    raw: read.value,
  }
}

/**
 * The reason pi rejects an entry, or null. A subset of pi's own validation —
 * the cases a person can produce from Settings or a hand edit — so a server
 * that will never load says so instead of sitting in the list looking fine.
 */
export function serverProblem(name: string, config: unknown, scope: McpScope): string | null {
  if (!MCP_SERVER_NAME.test(name))
    return `invalid server name "${name}" (use letters, digits, "_" and "-")`
  if (!isRecord(config)) return `server "${name}" must be an object`
  if (config.type === 'sse') {
    return `server "${name}": legacy SSE transport is not supported; use the streamable HTTP URL`
  }
  if (typeof config.url === 'string') {
    if (!URL.canParse(config.url) || !/^https?:$/.test(new URL(config.url).protocol)) {
      return `server "${name}": url must be an http or https URL`
    }
    if (config.auth !== undefined && !isRecord(config.auth)) {
      return `server "${name}": auth.provider must be a provider name`
    }
    if (scope === 'project' && config.auth !== undefined) {
      return `server "${name}": auth is only allowed in the global mcp.json`
    }
    return null
  }
  if (typeof config.command === 'string') return null
  return `server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`
}

const OVERRIDE_KEYS = new Set(['enabled', 'exposure', 'toolExposure'])

/** pi's resolution of the global and project files. */
export function resolveServers(
  globalServers: Record<string, McpServerConfig>,
  projectServers: Record<string, McpServerConfig>,
  paths: { global: string; project?: string },
): { servers: McpResolvedServer[]; errors: string[] } {
  const errors: string[] = []
  const byName = new Map<string, McpResolvedServer>()
  const add = (scope: McpScope, path: string, name: string, config: McpServerConfig): void => {
    const problem = serverProblem(name, config, scope)
    if (problem) {
      errors.push(`${path}: ${problem}`)
      return
    }
    const clash = [...byName.keys()].find(
      (other) => other !== name && mcpNamespace(other) === mcpNamespace(name),
    )
    if (clash) {
      errors.push(`${path}: server "${name}" conflicts with "${clash}"`)
      return
    }
    byName.set(name, {
      name,
      config,
      defined: config,
      scope,
      ...(scope === 'project' && byName.has(name) ? { replacesGlobal: true } : {}),
    })
  }

  for (const [name, config] of Object.entries(globalServers))
    add('global', paths.global, name, config)
  for (const [name, config] of Object.entries(projectServers)) {
    const path = paths.project ?? ''
    if (isRecord(config) && isMcpOverride(config)) {
      const base = byName.get(name)
      const extra = Object.keys(config).filter((key) => !OVERRIDE_KEYS.has(key))
      if (!base || base.scope !== 'global') {
        errors.push(
          `${path}: server "${name}" needs "command" or "url", or a global server to override`,
        )
      } else if (extra.length > 0) {
        errors.push(
          `${path}: server "${name}": an override can only set enabled, exposure, toolExposure`,
        )
      } else {
        byName.set(name, { ...base, config: { ...base.config, ...config }, overridden: true })
      }
      continue
    }
    add('project', path, name, config)
  }
  return { servers: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), errors }
}

/**
 * Whether pi reads the project's `.pi/mcp.json`. A Phosphor session cannot
 * answer pi's trust question (RPC has no UI for it), so the stored decision is
 * the whole answer: the nearest folder entry in `trust.json`, else the
 * `defaultProjectTrust` setting.
 */
export async function projectTrust(
  workspacePath: string,
  dirs: McpDirs = mcpDirs(),
): Promise<McpProjectTrust> {
  let path: string
  try {
    path = await realpath(resolve(workspacePath))
  } catch {
    path = resolve(workspacePath)
  }
  const store = await readJsonFile(join(dirs.piAgent, 'trust.json'))
  if (!store.malformed && isRecord(store.value)) {
    for (let dir = path; ; dir = dirname(dir)) {
      const decision = store.value[dir]
      if (decision === true || decision === false) {
        return { path, trusted: decision, source: 'trust-store' }
      }
      if (dirname(dir) === dir) break
    }
  }
  const settings = await readJsonFile(join(dirs.piAgent, 'settings.json'))
  const always = isRecord(settings.value) && settings.value.defaultProjectTrust === 'always'
  return { path, trusted: always, source: 'default' }
}

/** pi's user settings turn its built-in MCP off — what pi-mcp-adapter writes. */
export function disablesBuiltinMcp(settings: unknown): boolean {
  if (!isRecord(settings) || !Array.isArray(settings.extensions)) return false
  return settings.extensions.some((entry) => entry === '-builtin:mcp' || entry === '!builtin:mcp')
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Read both files and resolve them the way pi will. */
export async function readMcpConfigs(
  workspacePath: string | undefined,
  dirs: McpDirs = mcpDirs(),
): Promise<McpConfigsResult> {
  const chain = mcpConfigPaths(workspacePath, dirs)
  const parsed = await Promise.all(chain.map(({ scope, path }) => readMcpFileAt(scope, path)))
  const [global, project] = parsed
  const trust = workspacePath ? await projectTrust(workspacePath, dirs) : null

  const { servers, errors } = resolveServers(
    global!.servers,
    // An untrusted project file is not read by pi, so it resolves to nothing.
    trust?.trusted ? (project?.servers ?? {}) : {},
    { global: global!.state.path, ...(project ? { project: project.state.path } : {}) },
  )
  for (const file of parsed) {
    if (file.state.malformed)
      errors.unshift(`${file.state.path}: ${file.state.error ?? 'parse error'}`)
  }

  const settings = await readJsonFile(join(dirs.piAgent, 'settings.json'))
  const legacyFiles = await Promise.all(adapterConfigPaths(workspacePath, dirs).map(pathExists))
  return {
    servers,
    files: parsed.map((p) => p.state),
    errors,
    projectTrust: trust,
    legacy: legacyFiles.some(Boolean) || disablesBuiltinMcp(settings.value),
  }
}

function pathFor(scope: McpScope, workspacePath: string | undefined, dirs?: McpDirs): string {
  const entry = mcpConfigPaths(workspacePath, dirs).find((p) => p.scope === scope)
  if (!entry) throw new Error('A workspace is required for project-scoped MCP config.')
  return entry.path
}

async function mutateFile(
  scope: McpScope,
  workspacePath: string | undefined,
  dirs: McpDirs | undefined,
  mutate: (servers: Record<string, McpServerConfig>) => void,
): Promise<void> {
  const path = pathFor(scope, workspacePath, dirs)
  const file = await readMcpFileAt(scope, path)
  if (file.state.malformed) {
    throw new Error(
      `${path} is not valid (${file.state.error ?? 'parse error'}). ` +
        'Phosphor will not overwrite it — fix it via the raw editor first.',
    )
  }
  // Mutate the parsed object so unknown top-level keys survive.
  const raw = file.raw
  const servers = (raw.mcpServers ?? {}) as Record<string, McpServerConfig>
  mutate(servers)
  raw.mcpServers = servers
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(raw, null, 2) + '\n', 'utf8')
}

export async function upsertMcpServer(
  scope: McpScope,
  workspacePath: string | undefined,
  name: string,
  config: McpServerConfig,
  dirs?: McpDirs,
): Promise<void> {
  const problem = serverProblem(name, config, scope)
  if (problem) throw new Error(problem)
  if (typeof config.url === 'string' && typeof config.command === 'string') {
    throw new Error('An MCP server needs exactly one of `url` or `command`.')
  }
  await mutateFile(scope, workspacePath, dirs, (servers) => {
    servers[name] = config
  })
}

export async function removeMcpServer(
  scope: McpScope,
  workspacePath: string | undefined,
  name: string,
  dirs?: McpDirs,
): Promise<void> {
  await mutateFile(scope, workspacePath, dirs, (servers) => {
    delete servers[name]
  })
}

/**
 * Turn a server on or off in the file that decides it: the project file for a
 * server it defines or overrides, the global file otherwise. `true` is pi's
 * default and removes the key, except in an override, where an absent key
 * would mean "inherit" rather than "on".
 */
export async function setMcpServerEnabled(
  scope: McpScope,
  workspacePath: string | undefined,
  name: string,
  enabled: boolean,
  dirs?: McpDirs,
): Promise<void> {
  await mutateFile(scope, workspacePath, dirs, (servers) => {
    const existing = servers[name]
    if (!existing) throw new Error(`No MCP server "${name}" in this file.`)
    if (!enabled || isMcpOverride(existing)) existing.enabled = enabled
    else delete existing.enabled
  })
}

/** Raw file access for the escape-hatch editor (scope-addressed, never paths). */
export async function readMcpFile(
  scope: McpScope,
  workspacePath: string | undefined,
  dirs?: McpDirs,
): Promise<{ path: string; content: string }> {
  const path = pathFor(scope, workspacePath, dirs)
  try {
    return { path, content: await readFile(path, 'utf8') }
  } catch {
    return { path, content: '' }
  }
}

export async function writeMcpFile(
  scope: McpScope,
  workspacePath: string | undefined,
  content: string,
  dirs?: McpDirs,
): Promise<void> {
  JSON.parse(content) // must be valid JSON — refuse to write broken config
  const path = pathFor(scope, workspacePath, dirs)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
}
