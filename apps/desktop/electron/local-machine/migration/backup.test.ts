import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadSqlite } from '@phosphor/session-runtime/sqlite'
import {
  BACKUP_MANIFEST,
  ROUTINES_CONSISTENT,
  backupDirFor,
  backupUserData,
  readBackupJson,
  readBackupManifest,
} from './backup'

const ID = '00000000-0000-4000-8000-000000000001'
let root: string
let userData: string
let backupDir: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'm3-backup-'))
  userData = join(root, 'Phosphor')
  mkdirSync(join(userData, 'lane-archive'), { recursive: true })
  backupDir = backupDirFor(join(userData, 'daemon-migration'), ID)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function seedRoutines(file = 'routines.sqlite') {
  const { DatabaseSync } = loadSqlite()
  const db = new DatabaseSync(join(userData, file))
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE routines(id TEXT PRIMARY KEY, data TEXT)')
  db.prepare('INSERT INTO routines VALUES (?,?)').run('r1', '{"name":"one"}')
  return db
}

describe('backupUserData', () => {
  it('copies the prefs, archive manifests and routines, verified, with a manifest written last', () => {
    writeFileSync(join(userData, 'config.json'), '{"pinnedSessions":[]}')
    writeFileSync(join(userData, 'lane-archive', 'a.json'), '{"id":"a"}')
    writeFileSync(join(userData, 'drafts.txt'), 'never copied')
    const db = seedRoutines()
    try {
      const manifest = backupUserData({
        userData,
        backupDir,
        migrationId: ID,
        routinesFile: 'routines.sqlite',
      })
      expect(manifest.entries.map((e) => e.name)).toEqual(
        expect.arrayContaining(['config.json', 'lane-archive/a.json', 'routines.sqlite']),
      )
      expect(manifest.entries.map((e) => e.name)).not.toContain('drafts.txt')
      expect(readFileSync(join(backupDir, 'config.json'), 'utf8')).toBe('{"pinnedSessions":[]}')
      expect(readBackupJson(backupDir, 'config.json')).toEqual({ pinnedSessions: [] })
      expect(readBackupManifest(backupDir)).toEqual(manifest)
      // The consistent copy holds the row still in the WAL of the open writer.
      expect(manifest.routines?.name).toBe(ROUTINES_CONSISTENT)
      const { DatabaseSync } = loadSqlite()
      const copy = new DatabaseSync(join(backupDir, ROUTINES_CONSISTENT), { readOnly: true })
      try {
        expect(copy.prepare('SELECT id FROM routines').all()).toEqual([{ id: 'r1' }])
      } finally {
        copy.close()
      }
    } finally {
      db.close()
    }
  })

  it('reruns over a partial backup and converges on the same manifest', () => {
    writeFileSync(join(userData, 'config.json'), '{"a":1}')
    mkdirSync(backupDir, { recursive: true })
    writeFileSync(join(backupDir, 'config.json'), '{"a":')
    const first = backupUserData({
      userData,
      backupDir,
      migrationId: ID,
      routinesFile: 'routines.sqlite',
    })
    const second = backupUserData({
      userData,
      backupDir,
      migrationId: ID,
      routinesFile: 'routines.sqlite',
    })
    expect(second).toEqual(first)
    expect(readFileSync(join(backupDir, 'config.json'), 'utf8')).toBe('{"a":1}')
    expect(first.routines).toBeNull()
  })

  it('backs up the development routines file when that is the one Desktop uses', () => {
    seedRoutines('routines-dev.sqlite').close()
    const manifest = backupUserData({
      userData,
      backupDir,
      migrationId: ID,
      routinesFile: 'routines-dev.sqlite',
    })
    expect(manifest.entries.map((e) => e.name)).toContain('routines-dev.sqlite')
    expect(manifest.routines).not.toBeNull()
  })

  it('reads no manifest before the step finished', () => {
    expect(readBackupManifest(backupDir)).toBeNull()
    mkdirSync(backupDir, { recursive: true })
    writeFileSync(join(backupDir, BACKUP_MANIFEST), 'nope')
    expect(readBackupManifest(backupDir)).toBeNull()
  })
})
