import { copyFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { McpMigrationPlan, McpMigrationResult } from '@shared/mcp'
import { readJsonFile } from '@phosphor/session-runtime/pi/json-config'
import { mcpDirs, type McpDirs } from './mcp-config'
import { adapterSources, buildPlan, type ReadSource } from './mcp-migration-plan'
import { isRecord, type Entry } from './mcp-translation'

export { adapterSources, buildPlan, type ReadSource } from './mcp-migration-plan'
export { mergeAdapterEntry, translateEntry } from './mcp-translation'

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
