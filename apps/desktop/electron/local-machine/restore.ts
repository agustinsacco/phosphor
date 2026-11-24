import { readFileSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { atomicRecord } from '@phosphor/session-runtime/host-install/files'
import { errnoIs } from '@phosphor/session-runtime/fs-safety'
import {
  asRecord,
  readMigrationBackup,
  hasFile,
  liveConfig,
  writeConfig,
  type ConfigRecord,
} from '../prefs/migration-config'
import { backupDirFor } from './migration/backup'
import {
  MIGRATION_DIR,
  journalWriter,
  readJournal,
  stepDone,
  withState,
  type MigrationPermit,
} from './migration/journal'
import { migratedFile, restoreKeys, routineFiles, type RoutinesFile } from './migration/quarantine'

export const RESTORE_IN_APP_FLAG = '--restore-in-app-runtime'
export interface RestorePorts {
  userData: string
  permit: MigrationPermit
  routinesFile: RoutinesFile
  /** Answer true only after every lane stopped on the identified, attested service. Idempotent in standby. */
  stopLanes(machineId: string): Promise<boolean>
  /** True confirms durable standby, no scheduler, and no daemon owner lock. */
  releaseToStandby(machineId: string): Promise<boolean>
}

function availableBlobs(userData: string): Set<string> {
  try {
    return new Set(
      readdirSync(join(userData, 'drafts'), { withFileTypes: true }).flatMap((e) =>
        e.isFile() ? [e.name] : [],
      ),
    )
  } catch (e) {
    if (errnoIs(e, 'ENOENT')) return new Set()
    throw e
  }
}
function restoreDrafts(value: unknown, userData: string) {
  const blobs = availableBlobs(userData)
  return Object.fromEntries(
    Object.entries(asRecord(value)).flatMap(([key, raw]) => {
      const record = asRecord(raw)
      if (!Array.isArray(record.attachments)) throw new Error('Invalid saved draft.')
      const attachments = record.attachments.filter((a: unknown) => {
        const item = asRecord(a)
        return item.kind !== 'image' || (typeof item.blobId === 'string' && blobs.has(item.blobId))
      })
      if (attachments.length === record.attachments.length) return [[key, record]]
      return !attachments.length && !String(record.text ?? '').trim() && !record.swarm
        ? []
        : [[key, { ...record, attachments }]]
    }),
  )
}
function restoredConfig(userData: string, saved: ConfigRecord) {
  const next = liveConfig(userData)
  for (const key of restoreKeys) {
    if (Object.hasOwn(saved, key)) next[key] = saved[key]
    else delete next[key]
  }
  const lanes = { ...asRecord(next.lanes ?? {}) }
  const old = asRecord(saved.lanes ?? {})
  if (Object.hasOwn(old, 'autoName')) lanes.autoName = old.autoName
  else delete lanes.autoName
  if (next.lanes || Object.keys(lanes).length) next.lanes = lanes
  if (next.drafts) next.drafts = restoreDrafts(next.drafts, userData)
  return next
}

type Move = 'restore' | 'displace' | 'keep'
/** Persist the three decisions before moving anything: a retry must distinguish a restored WAL
 * from one the old Desktop wrote. Never pair an old WAL with the wrong main database. */
function routineRestorePlan(
  paths: string[],
  backupDir: string,
  id: string,
  original: boolean,
  quarantined: boolean,
): Move[] {
  const intent = join(backupDir, 'restore-routines.json')
  if (hasFile(intent)) {
    const value: unknown = JSON.parse(readFileSync(intent, 'utf8'))
    if (
      !Array.isArray(value) ||
      value.length !== paths.length ||
      !value.every((v): v is Move => v === 'restore' || v === 'keep' || v === 'displace')
    )
      throw new Error('Invalid routines restore record.')
    return value
  }
  const parked = hasFile(migratedFile(paths[0]!, id))
  if (original && !parked && (quarantined || !hasFile(paths[0]!)))
    throw new Error('The original routines database is missing.')
  return paths.map((path) =>
    hasFile(migratedFile(path, id)) ? 'restore' : parked || !original ? 'displace' : 'keep',
  )
}
function restoreRoutines(paths: string[], plan: Move[], id: string) {
  for (const [i, path] of paths.entries()) {
    const action = plan[i]
    if (action === 'keep') continue
    const parked = migratedFile(path, id)
    if (action === 'restore' && !hasFile(parked)) {
      if (!hasFile(path)) throw new Error('The original routines file is missing.')
      continue
    }
    if (hasFile(path)) {
      const after = `${path}.after-migration-${id}`
      if (hasFile(after)) throw new Error('A newer routines file cannot be moved aside safely.')
      renameSync(path, after)
    }
    if (action === 'restore') renameSync(parked, path)
  }
}

/** Called only for the explicit flag, under the single-instance launch lock, before the normal gate.
 * On refusal throw and terminate startup: neither runtime may be started by this invocation. */
export async function restoreInAppRuntime(ports: RestorePorts): Promise<void> {
  const { userData, permit, routinesFile } = ports
  const dir = join(userData, MIGRATION_DIR)
  const writer = journalWriter(dir, permit)
  const read = readJournal(dir)
  if (read.kind !== 'ok') throw new Error('There is no readable migration to restore.')
  const { journal } = read
  if (journal.state === 'reverted') return
  if (journal.state !== 'committed' || !journal.machineId)
    throw new Error('Only a committed migration can be restored.')
  const id = journal.migrationId
  const backupDir = backupDirFor(dir, id)
  const backup = readMigrationBackup(backupDir, id, routinesFile)
  const config = restoredConfig(userData, backup.config)
  const paths = routineFiles(userData, routinesFile)
  const moves = routineRestorePlan(
    paths,
    backupDir,
    id,
    backup.hasRoutines,
    stepDone(journal, 'quarantine'),
  )
  if (!(await ports.stopLanes(journal.machineId)))
    throw new Error(
      'Restore stopped: the Phosphor service did not confirm that its lanes stopped. Desktop has not restored any data.',
    )
  if (!(await ports.releaseToStandby(journal.machineId)))
    throw new Error(
      'Restore stopped: the Phosphor service did not confirm standby. Its lanes may be stopped. Desktop has not restored any data.',
    )
  atomicRecord(join(backupDir, 'restore-routines.json'), moves, 0o600)
  restoreRoutines(paths, moves, id)
  writeConfig(userData, config)
  const { retryRequested: _retry, ...blocked } = journal
  writer.write(withState(blocked, 'reverted', new Date().toISOString()))
}
