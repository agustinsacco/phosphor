import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hostBrainAdmission, hostBrainOwned } from './gate'
import { handoverPaths, writeRecord, type HandoverRecord } from './layout'

const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})
const ID = '00000000-0000-4000-8000-0000000000d1'
function state(): string {
  const folder = mkdtempSync(join(tmpdir(), 'ledger-host-'))
  folders.push(folder)
  return folder
}
const record = (stateDir: string, phase: HandoverRecord['state']) => {
  const paths = handoverPaths(stateDir, ID)
  mkdirSync(paths.move, { recursive: true })
  writeRecord(paths.record, {
    version: 1,
    migrationId: ID,
    state: phase,
    sourceSchema: 8,
    sourceGeneration: 'g',
    desktopVersion: '1.2.3',
  } satisfies HandoverRecord)
}
const claim = (stateDir: string) => {
  mkdirSync(handoverPaths(stateDir).root, { recursive: true })
  writeRecord(handoverPaths(stateDir).claim, { migrationId: ID })
}
const marker = (stateDir: string) => {
  mkdirSync(handoverPaths(stateDir).target, { recursive: true })
  writeRecord(handoverPaths(stateDir).marker, {
    version: 1,
    migrationId: ID,
    sourceGeneration: 'g',
  })
}

describe('hostBrainAdmission', () => {
  it('is open on a fresh Host and on one whose Brain was never moved', () => {
    const dir = state()
    expect(hostBrainAdmission(dir)).toEqual({ state: 'open' })
    mkdirSync(handoverPaths(dir).target)
    writeFileSync(join(handoverPaths(dir).target, 'brain.sqlite'), '')
    expect(hostBrainOwned(dir)).toBe(true)
  })

  it.each(['staged', 'verified'] as const)('refuses writes while a claimed move is %s', (phase) => {
    const dir = state()
    claim(dir)
    record(dir, phase)
    expect(hostBrainAdmission(dir)).toEqual({ state: 'handover', migrationId: ID })
    expect(hostBrainOwned(dir)).toBe(false)
  })

  it('a claim whose record never landed still holds the target', () => {
    const dir = state()
    claim(dir)
    expect(hostBrainOwned(dir)).toBe(false)
  })

  it('a published move is not the runtime’s until its conversation is bound and it commits', () => {
    const dir = state()
    claim(dir)
    record(dir, 'verified')
    marker(dir)
    expect(hostBrainAdmission(dir)).toEqual({ state: 'handover', migrationId: ID })
    record(dir, 'committed')
    expect(hostBrainAdmission(dir)).toEqual({ state: 'imported', migrationId: ID })
    expect(hostBrainOwned(dir)).toBe(true)
  })

  it.each([
    [
      'a corrupt claim',
      (dir: string) => {
        mkdirSync(handoverPaths(dir).root, { recursive: true })
        writeFileSync(handoverPaths(dir).claim, '{')
      },
    ],
    [
      'a corrupt marker',
      (dir: string) => {
        mkdirSync(handoverPaths(dir).target, { recursive: true })
        writeFileSync(handoverPaths(dir).marker, 'Kestrel')
      },
    ],
    ['a marker without its record', (dir: string) => marker(dir)],
    [
      'a corrupt record',
      (dir: string) => {
        claim(dir)
        mkdirSync(handoverPaths(dir, ID).move, { recursive: true })
        writeFileSync(handoverPaths(dir, ID).record, '[]')
      },
    ],
  ])('fails closed on %s', (_name, plant) => {
    const dir = state()
    plant(dir)
    expect(hostBrainAdmission(dir).state).toBe('blocked')
    expect(hostBrainOwned(dir)).toBe(false)
  })
})
