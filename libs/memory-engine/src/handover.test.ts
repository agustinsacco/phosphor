import { backup, DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BRAIN_TOMBSTONE_VERSION,
  backupBrainDatabase,
  brainHandoverDigest,
  brainIntegrityProblems,
  brainSourceSessions,
  brainTombstone,
  compareBrainHandover,
  exerciseBrainCopy,
  upgradeBrainDatabase,
  writeBrainTombstone,
} from './handover'
import { openBrainStore } from './store'

const sqlite = { DatabaseSync, backup }
const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function folder(): string {
  const directory = mkdtempSync(join(tmpdir(), 'harbor-handover-'))
  directories.push(directory)
  return directory
}
/** The v7 fixture: every journal kind, a read in review and one refreshing. */
function v7File(): string {
  const path = join(folder(), 'brain.sqlite')
  const db = new DatabaseSync(path)
  db.exec(readFileSync(new URL('./__fixtures__/schema-v7.sql', import.meta.url), 'utf8'))
  db.close()
  return path
}
/** The same Brain after the live store upgraded it to v8. */
function v8File(): string {
  const path = v7File()
  openBrainStore({ path, Database: DatabaseSync }).close()
  return path
}
/** Backup, digest the source, upgrade the copy and compare: what the Host does. */
async function handOver(source: string, tamper?: (db: DatabaseSync) => void) {
  const copy = join(folder(), 'brain.sqlite')
  const version = await backupBrainDatabase(sqlite, source, copy)
  const db = new DatabaseSync(copy)
  try {
    const digest = brainHandoverDigest(db, { upgradeV7: version === 7 })
    const upgraded = upgradeBrainDatabase(db)
    tamper?.(db)
    return {
      version,
      upgraded,
      digest,
      problems: compareBrainHandover(digest, db, DatabaseSync),
      integrity: brainIntegrityProblems(db),
    }
  } finally {
    db.close()
  }
}

describe('Brain handover copy', () => {
  it('upgrades a v7 Brain and finds no difference beyond the v8 steps', async () => {
    const result = await handOver(v7File())
    expect(result.upgraded).toEqual({ from: 7, to: 8 })
    expect(result.problems).toEqual([])
    expect(result.integrity).toEqual([])
    expect(result.digest.counts.memories).toBeGreaterThan(0)
    expect(result.digest.counts.journal).toBeGreaterThan(0)
  })

  it('moves a v8 Brain unchanged, ended relations and journal included', async () => {
    const result = await handOver(v8File())
    expect(result.upgraded).toEqual({ from: 8, to: 8 })
    expect(result.problems).toEqual([])
    expect(result.digest.counts.relations).toBeGreaterThan(0)
  })

  it.each([
    [
      'a memory sentence',
      'UPDATE memories SET summary = summary || ?',
      'memories: content differs',
    ],
    ['a journal row', 'DELETE FROM tidy_operation_memories WHERE ? IS NOT NULL', 'differs'],
    ['an upgraded link label', "UPDATE relations SET label = 'Tom Lee' || ?", 'not at its default'],
    [
      'the reader model',
      "UPDATE meta SET value = json_set(value,'$.model','fake/' || ?) WHERE key='prefs'",
      'prefs',
    ],
  ])('notices a changed %s', async (_name, sql, problem) => {
    const result = await handOver(v7File(), (db) => db.prepare(sql).run('Kestrel'))
    expect(result.problems.join('\n')).toContain(problem)
  })

  it('exercises a disposable upgraded copy: map, recall, walk and an undo', async () => {
    const path = join(folder(), 'brain.sqlite')
    await backupBrainDatabase(sqlite, v7File(), path)
    const db = new DatabaseSync(path)
    upgradeBrainDatabase(db)
    db.close()
    const result = await exerciseBrainCopy(DatabaseSync, path, Date.parse('2026-11-01'))
    expect(result.overview).toBeGreaterThan(0)
    expect(result.expanded).toBe(true)
    expect(result.undo).not.toBe('none')
  })

  it('refuses a Brain older than v7 rather than starting over', async () => {
    const path = join(folder(), 'brain.sqlite')
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE meta(key TEXT, value TEXT); PRAGMA user_version = 3;')
    db.close()
    await expect(backupBrainDatabase(sqlite, path, join(folder(), 'copy'))).rejects.toThrow(
      'A version 3 Brain cannot move.',
    )
  })

  it('lists the lanes a Brain read and the Brain Agent transcripts it ran in', async () => {
    const db = new DatabaseSync(v8File(), { readOnly: true })
    try {
      const sessions = brainSourceSessions(db)
      expect(sessions.lanes.length).toBeGreaterThan(0)
      expect(sessions.lanes).toEqual([...sessions.lanes].sort())
    } finally {
      db.close()
    }
  })
})

describe('Brain tombstone', () => {
  it('names its migration, and every engine refuses it without touching it', async () => {
    const path = join(folder(), 'brain.sqlite')
    writeBrainTombstone(DatabaseSync, path, 'migration-harbor')
    expect(brainTombstone(DatabaseSync, path)).toBe('migration-harbor')
    expect(() => openBrainStore({ path, Database: DatabaseSync })).toThrow(
      'requires a newer application',
    )
    expect(brainTombstone(DatabaseSync, path)).toBe('migration-harbor')
    await expect(backupBrainDatabase(sqlite, path, join(folder(), 'copy'))).rejects.toThrow(
      'already moved',
    )
    const db = new DatabaseSync(path, { readOnly: true })
    expect(db.prepare('PRAGMA user_version').get()).toEqual({
      user_version: BRAIN_TOMBSTONE_VERSION,
    })
    db.close()
  })

  it('is not mistaken for a real Brain or a missing file', () => {
    expect(brainTombstone(DatabaseSync, v8File())).toBeNull()
    expect(brainTombstone(DatabaseSync, join(folder(), 'none.sqlite'))).toBeNull()
  })
})
