import type { DatabaseSync } from 'node:sqlite'
import { loadSqlite } from '../sqlite'
import { SCHEMA_VERSION } from '../schema'
import { LANE_MARKS_SCHEMA } from './marks'
import { prepareStateDirectory, prepareStateFile, StateFailure } from '../state-dir'
import type { StorePorts } from './types'

interface StoreRecovery {
  migrate(): void
  markInterrupted(): void
  pruneReceipts(now: number): void
}

export async function openStoreDatabase<T extends StoreRecovery>(
  directory: string,
  uid: number | undefined,
  ports: StorePorts,
  constructStore: (db: DatabaseSync, ports: StorePorts) => T,
): Promise<T> {
  let db: DatabaseSync | undefined
  try {
    prepareStateDirectory(directory, uid)
    const path = prepareStateFile(directory, uid)
    const sqlite = await loadSqlite()
    db = new sqlite.DatabaseSync(path)
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;')
    const version = db.prepare('PRAGMA user_version').get()?.user_version
    if (typeof version !== 'number' || version > SCHEMA_VERSION)
      throw new StateFailure(directory, 78, 'this state was written by a newer Host')
    const store = constructStore(db, ports)
    if (version === 0) store.migrate()
    db.exec(LANE_MARKS_SCHEMA)
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
    store.markInterrupted()
    store.pruneReceipts((ports.now ?? Date.now)())
    return store
  } catch (error) {
    db?.close()
    if (error instanceof StateFailure) throw error
    throw new StateFailure(directory, 70, 'Could not open state.sqlite.')
  }
}
