import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { writeBrainTombstone } from '@phosphor/memory-engine/handover'
import {
  BrainOwnerMoved,
  brainHandoverPaths,
  desktopBrainOwner,
  isBrainTombstoneFile,
  requireDesktopBrainOwner,
  writeBrainHandoverRecord,
} from './owner-gate'

const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})
function userData(): string {
  const folder = mkdtempSync(join(tmpdir(), 'harbor-userdata-'))
  folders.push(folder)
  mkdirSync(join(folder, 'brain'))
  return folder
}
const ID = '00000000-0000-4000-8000-000000000001'

describe('desktopBrainOwner', () => {
  it('is Desktop with no move, and again after an abort', () => {
    const dir = userData()
    expect(desktopBrainOwner(dir)).toBe('desktop')
    writeBrainHandoverRecord(dir, { version: 1, migrationId: ID, phase: 'aborted' })
    expect(desktopBrainOwner(dir)).toBe('desktop')
    expect(() => requireDesktopBrainOwner(dir)).not.toThrow()
  })

  it.each([
    ['fenced', 'moving'],
    ['tombstoned', 'moving'],
    ['committed', 'host'],
  ] as const)('a %s move answers %s and refuses Desktop writes', (phase, owner) => {
    const dir = userData()
    writeBrainHandoverRecord(dir, { version: 1, migrationId: ID, phase })
    expect(desktopBrainOwner(dir)).toBe(owner)
    expect(() => requireDesktopBrainOwner(dir)).toThrow(BrainOwnerMoved)
  })

  it('a tombstone without a record is a move whose outcome is unknown', () => {
    const dir = userData()
    writeBrainTombstone(DatabaseSync, brainHandoverPaths(dir).legacy, ID)
    expect(isBrainTombstoneFile(brainHandoverPaths(dir).legacy)).toBe(true)
    expect(desktopBrainOwner(dir)).toBe('moving')
  })

  it('an unreadable record never reads as Desktop', () => {
    const dir = userData()
    mkdirSync(brainHandoverPaths(dir).root)
    writeFileSync(brainHandoverPaths(dir).record, '{"version":1,"phase":"maybe"}')
    expect(desktopBrainOwner(dir)).toBe('moving')
  })

  it('an ordinary Brain file is not a tombstone', () => {
    const dir = userData()
    const db = new DatabaseSync(brainHandoverPaths(dir).legacy)
    db.exec('PRAGMA user_version = 8; CREATE TABLE meta(key TEXT, value TEXT);')
    db.close()
    expect(isBrainTombstoneFile(brainHandoverPaths(dir).legacy)).toBe(false)
    expect(desktopBrainOwner(dir)).toBe('desktop')
  })
})
