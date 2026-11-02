import { readFile } from 'node:fs/promises'
import {
  isMcpExposure,
  isMcpOverride,
  type McpExposure,
  type McpScope,
  type McpServerConfig,
} from '@phosphor/shared/mcp'
import { machineRecord } from '@phosphor/shared/host-protocol-machine'
import { mcpConfigPaths, serverProblem, type McpDirs } from './mcp-config'
import {
  DESKTOP_FILE_POLICY,
  readSettingsBytes,
  saveSettingsFile,
  settingsFile,
  withSettingsFileLock,
  writeSettingsText,
} from './settings-file'

/**
 * Desktop's writes to pi's two MCP files (see `mcp-config.ts` for how pi reads
 * them), through the shared settings-file writer with This Mac's dotfile
 * policy. A Host writes its own through `apps/host/src/settings`.
 */

function pathFor(scope: McpScope, workspacePath: string | undefined, dirs?: McpDirs): string {
  const entry = mcpConfigPaths(workspacePath, dirs).find((p) => p.scope === scope)
  if (!entry) throw new Error('A workspace is required for project-scoped MCP config.')
  return entry.path
}

/** Desktop's structured edits: the shared writer, with This Mac's dotfile policy. */
async function mutateFile(
  scope: McpScope,
  workspacePath: string | undefined,
  dirs: McpDirs | undefined,
  mutate: (servers: Record<string, McpServerConfig>) => void,
): Promise<void> {
  const path = pathFor(scope, workspacePath, dirs)
  const refuse = (problem: string) =>
    new Error(
      `${path} is not valid (${problem}). ` +
        'Phosphor will not overwrite it — fix it via the raw editor first.',
    )
  await withSettingsFileLock(path, async () => {
    let file: { raw: Record<string, unknown>; revision: string }
    try {
      file = settingsFile(path, DESKTOP_FILE_POLICY)
    } catch (error) {
      throw refuse(error instanceof Error ? error.message : String(error))
    }
    // Mutate the parsed object so unknown top-level keys survive.
    const raw = file.raw
    if (raw.mcpServers !== undefined && !machineRecord(raw.mcpServers))
      throw refuse('expected an object with an "mcpServers" object')
    const servers = (raw.mcpServers ?? {}) as Record<string, McpServerConfig>
    mutate(servers)
    raw.mcpServers = servers
    await saveSettingsFile(path, raw, file.revision, () => true, DESKTOP_FILE_POLICY)
  })
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

/** Change exposure without copying credentials or replacing an override with a full definition. */
export async function setMcpExposure(
  scope: McpScope,
  workspacePath: string | undefined,
  name: string,
  exposure: McpExposure,
  tools: Record<string, McpExposure>,
  dirs?: McpDirs,
): Promise<void> {
  if (
    !isMcpExposure(exposure) ||
    !tools ||
    typeof tools !== 'object' ||
    Array.isArray(tools) ||
    Object.keys(tools).length > 2000 ||
    Object.entries(tools).some(([key, value]) => !key || key.length > 256 || !isMcpExposure(value))
  )
    throw new Error('Invalid MCP exposure rules.')
  await mutateFile(scope, workspacePath, dirs, (servers) => {
    const existing = servers[name]
    if (!existing) throw new Error(`No MCP server "${name}" in this file.`)
    if (!Object.hasOwn(servers, name)) throw new Error(`No MCP server "${name}" in this file.`)
    existing.exposure = exposure
    existing.toolExposure = tools
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
  await withSettingsFileLock(path, async () => {
    // The raw editor is how a malformed file gets fixed, so only its bytes are checked.
    const { revision } = readSettingsBytes(path, DESKTOP_FILE_POLICY)
    await writeSettingsText(path, content, revision, () => true, DESKTOP_FILE_POLICY)
  })
}
