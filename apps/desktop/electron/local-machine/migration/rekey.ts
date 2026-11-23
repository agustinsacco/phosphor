import { remoteLaneKey, remoteLaneResourceKey } from '@phosphor/shared/remote-host'
import { remotePrKey } from '@phosphor/shared/host-protocol-github'
import { asRecord, strings, type ConfigRecord } from '../../prefs/migration-config'
import type { MigrationPlan } from './plan'

/** Old Desktop also kept remote lane marks, under this exact opaque tuple, not a path. */
export function isHostSessionKey(key: string): boolean {
  if (!key.startsWith('[')) return false
  try {
    const tuple: unknown = JSON.parse(key)
    return (
      Array.isArray(tuple) &&
      tuple.length === 4 &&
      tuple[0] === 'remote' &&
      tuple[2] === 'session' &&
      typeof tuple[1] === 'string' &&
      typeof tuple[3] === 'string' &&
      remoteLaneResourceKey(tuple[1], tuple[3]) === key
    )
  } catch {
    return false
  }
}

function lookup(table: Readonly<Record<string, string>>, key: unknown): string | undefined {
  return typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined
}

function draftsFor(
  saved: ConfigRecord,
  plan: MigrationPlan,
  folders: Readonly<Record<string, string>>,
  host: string,
  orphan: () => void,
): ConfigRecord {
  const mapped: [string, unknown][] = []
  const records = asRecord(saved.drafts ?? {})
  const home = `home:host:${host}/machine`
  const lastRepo = lookup(folders, saved.lastWorkspacePath)
  const exact = `home:${String(saved.lastWorkspacePath)}`
  const homeSource = Object.hasOwn(records, exact)
    ? exact
    : Object.keys(records).find(
        (key) => key.startsWith('home:') && lastRepo && lookup(folders, key.slice(5)) === lastRepo,
      )
  for (const [key, value] of Object.entries(records)) {
    if (isHostSessionKey(key) || key.startsWith('home:host:')) {
      mapped.push([key, value])
      continue
    }
    const lane = key.startsWith('session:') && lookup(plan.laneIds, key.slice(8))
    const repo = key === homeSource ? lastRepo : undefined
    const target = lane ? remoteLaneResourceKey(host, lane) : repo ? home : undefined
    if (!target || Object.hasOwn(records, target)) {
      orphan()
      continue
    }
    const record = asRecord(value)
    mapped.push([
      target,
      {
        ...record,
        key: target,
        ...(record.workspacePath !== undefined
          ? { workspacePath: lane ? remoteLaneKey(host, lane) : remotePrKey(host, repo as string) }
          : {}),
      },
    ])
  }
  return Object.fromEntries(mapped)
}

/** Device state comes exclusively from the backup. Do not turn a retry into a second translation. */
export function rekeyDevice(
  saved: ConfigRecord,
  plan: MigrationPlan & { readonly folderAliases?: Readonly<Record<string, string>> },
  host: string,
) {
  const folders = { ...plan.folderAliases, ...plan.repositoryIds }
  let orphans = 0
  const orphan = () => {
    orphans++
  }
  const mapList = (
    value: unknown,
    table: Readonly<Record<string, string>>,
    key: (host: string, id: string) => string,
  ) => [
    ...new Set(
      strings(value).flatMap((path) => {
        if (path.startsWith('host:')) return [path]
        const id = lookup(table, path)
        if (id) return [key(host, id)]
        orphan()
        return []
      }),
    ),
  ]
  const laneId = lookup(plan.laneIds, saved.lastSessionPath)
  if (saved.lastSessionPath && !laneId) orphan()
  const repositoryId = lookup(folders, saved.lastWorkspacePath)
  if (saved.lastWorkspacePath && !repositoryId) orphan()
  const fields = {
    lastLocal: { ...(laneId ? { laneId } : {}), ...(repositoryId ? { repositoryId } : {}) },
    sessionOrder: mapList(saved.sessionOrder, plan.laneIds, remoteLaneKey),
    collapsedWorkspaces: mapList(saved.collapsedWorkspaces, folders, remotePrKey),
    drafts: draftsFor(saved, plan, folders, host, orphan),
  }
  return { fields, orphans }
}
