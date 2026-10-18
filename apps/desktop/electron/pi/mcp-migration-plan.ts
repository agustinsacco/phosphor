import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  isMcpExposure,
  isMcpOverride,
  mcpNamespace,
  type McpExposure,
  type McpMigrationPlan,
  type McpScope,
  type McpServerConfig,
} from '@shared/mcp'
import { disablesBuiltinMcp, type McpDirs } from './mcp-config'
import {
  isRecord,
  mergeAdapterEntry,
  SILENT_KEYS,
  translateEntry,
  type Entry,
} from './mcp-translation'

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
