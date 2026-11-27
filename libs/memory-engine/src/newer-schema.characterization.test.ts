import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { openBrainStore } from './store'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/**
 * What the Brain handover tombstone relies on: the engine refuses a file whose schema is newer
 * than its own and leaves it as it was, rather than starting a new knowledge store there.
 */
it('refuses a Brain file with a newer schema and keeps its rows', () => {
  const directory = mkdtempSync(join(tmpdir(), 'harbor-newer-'))
  directories.push(directory)
  const path = join(directory, 'brain.sqlite')
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE ledger_note(text TEXT); INSERT INTO ledger_note VALUES ('Harbor');
    PRAGMA user_version = 1000000;`)
  db.close()
  expect(() => openBrainStore({ path, Database: DatabaseSync })).toThrow(
    'This Brain database requires a newer application.',
  )
  const after = new DatabaseSync(path, { readOnly: true })
  expect(after.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1_000_000 })
  expect(after.prepare('SELECT text FROM ledger_note').all()).toEqual([{ text: 'Harbor' }])
  expect(after.prepare("SELECT name FROM sqlite_master WHERE name='meta'").get()).toBeUndefined()
  after.close()
})
