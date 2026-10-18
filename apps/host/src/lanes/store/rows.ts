import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import {
  HOST_LIMITS,
  type LaneControl,
  type RepositorySummary,
} from '@phosphor/shared/host-protocol'
import { absolutePath, check, integer, text, uuid } from '../validation'
import type { StoredLane } from './types'

export interface RowPorts {
  isConnected: (clientId: string) => boolean
  logCorruptLane: (count: number) => void
}

export type Row = Record<string, SQLOutputValue>
export function str(row: Row, key: string): string {
  const value = row[key]
  check(typeof value === 'string')
  return value
}
export function nullable(row: Row, key: string): string | null {
  const value = row[key]
  check(value === null || typeof value === 'string')
  return value
}
export function num(row: Row, key: string): number {
  const raw = row[key]
  check(typeof raw === 'number' || typeof raw === 'bigint')
  const value = Number(raw)
  integer(value)
  return value
}
export const iso = (value: number) => new Date(value).toISOString()
export function timestamp(value: string): number {
  const parsed = Date.parse(value)
  integer(parsed)
  check(iso(parsed) === value)
  return parsed
}

export function controlFromRow(row: Row, isConnected: (clientId: string) => boolean): LaneControl {
  const clientId = nullable(row, 'controller_client_id')
  return {
    fence: num(row, 'fence'),
    controller:
      clientId === null
        ? null
        : {
            clientId,
            label: str(row, 'controller_label'),
            connected: isConnected(clientId),
          },
  }
}
export function summaryQuery(db: DatabaseSync, sql: string) {
  const query = db.prepare(sql)
  // SQLite can hold integers beyond JS's safe range. Read them losslessly
  // so validation can skip that row instead of the driver failing the read.
  query.setReadBigInts(true)
  return query
}
function logCorruptRow(logCorruptLane: (count: number) => void): null {
  try {
    logCorruptLane(1)
  } catch {
    // A logger failure cannot expose corrupt state or fail a read.
  }
  return null
}
export function laneFromRow(row: Row, ports: RowPorts): StoredLane | null {
  try {
    const laneId = str(row, 'lane_id')
    uuid(laneId)
    check(laneId[14] === '4')
    const repositoryId = str(row, 'repository_id')
    check(/^[0-9a-f]{16}$/.test(repositoryId))
    const cwd = str(row, 'cwd')
    absolutePath(cwd)
    const sessionFile = nullable(row, 'session_file')
    if (sessionFile !== null) absolutePath(sessionFile)
    const title = nullable(row, 'title')
    const branch = nullable(row, 'branch')
    const provider = nullable(row, 'provider')
    const model = nullable(row, 'model')
    text(title, HOST_LIMITS.labelChars, true)
    text(branch, 256)
    text(provider, 64)
    text(model, 128)
    check((provider === null) === (model === null))
    const worktree = num(row, 'worktree')
    check(worktree === 0 || worktree === 1)
    const created = num(row, 'created_at')
    const updated = num(row, 'updated_at')
    check(updated >= created)
    const attention = num(row, 'attention')
    const read = num(row, 'read')
    check(read <= attention)
    integer(num(row, 'fence'), 1)
    const clientId = nullable(row, 'controller_client_id')
    const label = nullable(row, 'controller_label')
    check((clientId === null) === (label === null))
    if (clientId !== null) uuid(clientId)
    text(label, HOST_LIMITS.labelChars)
    return {
      laneId,
      repositoryId,
      cwd,
      sessionFile,
      title,
      branch,
      worktree: worktree === 1,
      model: provider === null || model === null ? null : { provider, id: model },
      activity: 'stopped',
      createdAt: iso(created),
      updatedAt: iso(updated),
      attention,
      read,
      control: controlFromRow(row, ports.isConnected),
      removedAt: row.removed_at === null ? null : iso(num(row, 'removed_at')),
    }
  } catch {
    return logCorruptRow(ports.logCorruptLane)
  }
}
export function repositoryFromRow(
  row: Row,
  logCorruptLane: (count: number) => void,
): RepositorySummary | null {
  try {
    const id = str(row, 'id')
    check(/^[0-9a-f]{16}$/.test(id))
    const path = str(row, 'path')
    absolutePath(path)
    const name = str(row, 'name')
    text(name, 4096)
    const active = num(row, 'active')
    check(active === 0 || active === 1)
    iso(num(row, 'added_at'))
    return { id, name, path }
  } catch {
    return logCorruptRow(logCorruptLane)
  }
}
