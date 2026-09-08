import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  McpCacheEntry,
  McpConfigsResult,
  McpFileState,
  McpResolvedServer,
  McpScope,
  McpServerConfig,
  McpWriteScope,
} from '@shared/mcp'
import { piAgentDir } from './pi-paths'
import { readJsonFile } from './json-config'

/**
 * mcp.json management for the pi-mcp-adapter's config chain (see shared/mcp.ts
 * for the precedence). The renderer only ever names a scope — paths are
 * resolved here, in the main process.
 */

export interface McpDirs {
  home: string
  xdgConfig: string
  piAgent: string
}

function defaultDirs(): McpDirs {
  return {
    home: homedir(),
    xdgConfig: process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
    piAgent: piAgentDir(),
  }
}

/** Chain paths, lowest → highest precedence. Dirs injectable for tests. */
export function mcpConfigPaths(
  workspacePath: string | undefined,
  dirs: McpDirs = defaultDirs(),
): Array<{ scope: McpScope; path: string }> {
  const paths: Array<{ scope: McpScope; path: string }> = [
    { scope: 'xdg', path: join(dirs.xdgConfig, 'mcp', 'mcp.json') },
    { scope: 'agents', path: join(dirs.home, '.agents', 'mcp.json') },
    { scope: 'agents-dir', path: join(dirs.home, '.agents', 'mcp', 'mcp.json') },
    { scope: 'pi-global', path: join(dirs.piAgent, 'mcp.json') },
  ]
  if (workspacePath) {
    paths.push({ scope: 'project', path: join(workspacePath, '.mcp.json') })
    paths.push({ scope: 'pi-project', path: join(workspacePath, '.pi', 'mcp.json') })
  }
  return paths
}

interface ParsedFile {
  state: McpFileState
  servers: Record<string, McpServerConfig>
  /** Full parsed object, preserved verbatim on writes. */
  raw: Record<string, unknown>
}

async function readMcpFileAt(scope: McpScope, path: string): Promise<ParsedFile> {
  const base: Omit<McpFileState, 'serverNames'> = {
    scope,
    path,
    exists: false,
    malformed: false,
  }
  const read = await readJsonFile(path)
  if (read.malformed) {
    return {
      state: {
        ...base,
        exists: true,
        malformed: true,
        error: read.error,
        serverNames: [],
      },
      servers: {},
      raw: {},
    }
  }
  if (!read.exists) {
    return { state: { ...base, serverNames: [] }, servers: {}, raw: {} }
  }
  const servers =
    read.value.mcpServers && typeof read.value.mcpServers === 'object'
      ? (read.value.mcpServers as Record<string, McpServerConfig>)
      : {}
  return {
    state: { ...base, exists: true, serverNames: Object.keys(servers) },
    servers,
    raw: read.value,
  }
}

/** Read the whole chain and resolve precedence (last wins, shadows noted). */
export async function readMcpConfigs(
  workspacePath: string | undefined,
  dirs?: McpDirs,
): Promise<McpConfigsResult> {
  const chain = mcpConfigPaths(workspacePath, dirs)
  const parsed = await Promise.all(chain.map(({ scope, path }) => readMcpFileAt(scope, path)))

  const byName = new Map<string, McpResolvedServer>()
  for (const file of parsed) {
    for (const [name, config] of Object.entries(file.servers)) {
      const existing = byName.get(name)
      byName.set(name, {
        name,
        config,
        scope: file.state.scope,
        shadows: existing ? [...existing.shadows, existing.scope] : [],
      })
    }
  }

  return {
    servers: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    files: parsed.map((p) => p.state),
  }
}

function resolveWriteScope(
  scope: McpScope,
  workspacePath: string | undefined,
  dirs?: McpDirs,
): { path: string } {
  const entry = mcpConfigPaths(workspacePath, dirs).find((p) => p.scope === scope)
  if (!entry) {
    throw new Error(
      scope === 'project' || scope === 'pi-project'
        ? 'A workspace is required for project-scoped MCP config.'
        : `Unknown MCP scope: ${scope}`,
    )
  }
  return { path: entry.path }
}

function validateServer(name: string, config: McpServerConfig): void {
  if (!name || /[/\\]/.test(name)) {
    throw new Error(`Invalid MCP server name "${name}".`)
  }
  const hasUrl = typeof config.url === 'string' && config.url.length > 0
  const hasCommand = typeof config.command === 'string' && config.command.length > 0
  if (hasUrl === hasCommand) {
    throw new Error('An MCP server needs exactly one of `url` or `command`.')
  }
}

async function mutateFile(
  scope: McpScope,
  workspacePath: string | undefined,
  dirs: McpDirs | undefined,
  mutate: (servers: Record<string, McpServerConfig>) => void,
): Promise<void> {
  const { path } = resolveWriteScope(scope, workspacePath, dirs)
  const file = await readMcpFileAt(scope, path)
  if (file.state.malformed) {
    throw new Error(
      `${path} is not valid JSON (${file.state.error ?? 'parse error'}). ` +
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
  scope: McpWriteScope,
  workspacePath: string | undefined,
  name: string,
  config: McpServerConfig,
  dirs?: McpDirs,
): Promise<void> {
  validateServer(name, config)
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

/** Toggle `disabled` in the server's own source file (unambiguous semantics). */
export async function setMcpServerDisabled(
  scope: McpScope,
  workspacePath: string | undefined,
  name: string,
  disabled: boolean,
  dirs?: McpDirs,
): Promise<void> {
  await mutateFile(scope, workspacePath, dirs, (servers) => {
    const existing = servers[name]
    if (!existing) throw new Error(`No MCP server "${name}" in this file.`)
    if (disabled) existing.disabled = true
    else delete existing.disabled
  })
}

/** Raw file access for the escape-hatch editor (scope-addressed, never paths). */
export async function readMcpFile(
  scope: McpScope,
  workspacePath: string | undefined,
  dirs?: McpDirs,
): Promise<{ path: string; content: string }> {
  const { path } = resolveWriteScope(scope, workspacePath, dirs)
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
  const { path } = resolveWriteScope(scope, workspacePath, dirs)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
}

/**
 * Tolerant read of the adapter's metadata cache (display-only tool lists).
 * The cache shape is the adapter's own; we scrape name → tool names and drop
 * anything that doesn't look right.
 */
export async function readMcpCache(dirs?: McpDirs): Promise<McpCacheEntry[]> {
  const path = join((dirs ?? defaultDirs()).piAgent, 'mcp-cache.json')
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const entries: McpCacheEntry[] = []
  const scrape = (name: string, value: unknown): void => {
    if (!value || typeof value !== 'object') return
    const tools = (value as { tools?: unknown }).tools
    if (Array.isArray(tools)) {
      entries.push({
        name,
        tools: tools
          .map((t) =>
            typeof t === 'string' ? t : ((t as { name?: unknown })?.name as string | undefined),
          )
          .filter((t): t is string => typeof t === 'string'),
      })
    }
  }
  const root = parsed as Record<string, unknown>
  const servers = (root.servers ?? root) as Record<string, unknown>
  if (servers && typeof servers === 'object') {
    for (const [name, value] of Object.entries(servers)) scrape(name, value)
  }
  return entries
}
