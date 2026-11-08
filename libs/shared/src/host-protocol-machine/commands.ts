import type { RpcSlashCommand, SourceInfo } from '../rpc'

/**
 * A Host's `machine.commands` answer: pi's `get_commands` for one repository,
 * projected to the fields the `/` menu reads (`commandCatalogue.ts`). Only
 * reviewed fields cross; pi's open-ended metadata never does. A lane's own
 * `lane.commands` already carries the same shape, so a new Host lane and a
 * running one list commands the same way.
 */
export const MACHINE_COMMANDS_LIMIT = 2000

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0')
const SOURCES = ['extension', 'prompt', 'skill'] as const
const SCOPES = ['user', 'project', 'temporary'] as const
const ORIGINS = ['package', 'top-level'] as const

function parseSourceInfo(v: unknown): SourceInfo | null {
  if (!record(v) || !text(v.path, 4096) || !text(v.source, 200)) return null
  const scope = SCOPES.find((s) => s === v.scope)
  const origin = ORIGINS.find((o) => o === v.origin)
  if (!scope || !origin) return null
  if (v.baseDir !== undefined && !text(v.baseDir, 4096)) return null
  return {
    path: v.path,
    source: v.source,
    scope,
    origin,
    ...(typeof v.baseDir === 'string' ? { baseDir: v.baseDir } : {}),
  }
}

export function parseMachineCommands(v: unknown): RpcSlashCommand[] | null {
  if (!Array.isArray(v) || v.length > MACHINE_COMMANDS_LIMIT) return null
  const out: RpcSlashCommand[] = []
  for (const c of v) {
    if (!record(c) || !text(c.name, 200)) return null
    const source = SOURCES.find((s) => s === c.source)
    if (!source) return null
    if (
      c.description !== undefined &&
      (typeof c.description !== 'string' || c.description.length > 2048)
    )
      return null
    const sourceInfo = c.sourceInfo === undefined ? undefined : parseSourceInfo(c.sourceInfo)
    if (sourceInfo === null) return null
    out.push({
      name: c.name,
      ...(typeof c.description === 'string' ? { description: c.description } : {}),
      source,
      ...(sourceInfo ? { sourceInfo } : {}),
    })
  }
  return out
}
