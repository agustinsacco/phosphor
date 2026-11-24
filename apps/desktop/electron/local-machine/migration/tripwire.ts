import { join } from 'node:path'
import { loadSqlite } from '@phosphor/session-runtime/sqlite'
import { atomicRecord } from '@phosphor/session-runtime/host-install/files'
import { liveConfig, hasFile } from '../../prefs/migration-config'
import { MIGRATION_DIR, readJournal, stepDone } from './journal'
import type { RoutinesFile } from './quarantine'

export interface TripwirePorts {
  userData: string
  routinesFile: RoutinesFile
  warn(message: string): void | Promise<void>
  log(event: string): void
  rescan(machineId: string): Promise<void>
}
function hasRoutines(path: string) {
  if (!hasFile(path)) return false
  const db = new (loadSqlite().DatabaseSync)(path, { readOnly: true })
  try {
    return !!db.prepare('SELECT 1 FROM routines LIMIT 1').get()
  } finally {
    db.close()
  }
}
/** Daemon-mode launch only. Never start or repair an old runtime here. An empty database
 * is just the old opener's side effect; populated legacy data is evidence of another writer. */
export async function checkMigrationTripwire(ports: TripwirePorts): Promise<void> {
  const dir = join(ports.userData, MIGRATION_DIR)
  const read = readJournal(dir)
  if (
    read.kind !== 'ok' ||
    read.journal.state !== 'committed' ||
    !read.journal.machineId ||
    !stepDone(read.journal, 'quarantine')
  )
    return
  const config = liveConfig(ports.userData)
  if (
    !config.lastSessionPath &&
    !(Array.isArray(config.recentWorkspaces) && config.recentWorkspaces.length) &&
    !hasRoutines(join(ports.userData, ports.routinesFile))
  )
    return
  const marker = join(dir, `tripwire-${read.journal.migrationId}.json`)
  if (!hasFile(marker)) {
    ports.log('legacy-desktop-detected')
    await ports.warn(
      'An older Desktop used this data after migration. Close it and use this version to open lanes.',
    )
    atomicRecord(marker, { warned: true }, 0o600)
  }
  await ports.rescan(read.journal.machineId)
}
