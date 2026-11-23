import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MigrationImport, MigrationLaneItem } from '@phosphor/shared/host-protocol-owner'
import { openStore, type HostStore } from '../lanes/store'
import { OwnerCallRefused, type OwnerCallContext } from './adapter'
import {
  createOwnerMigration,
  MIGRATION_REFUSALS,
  type MigrationImporters,
  type OwnerMigrationPorts,
} from './migrate'
import { withMigrationRecords } from './staging'

const uid = process.getuid?.()
const call = {} as OwnerCallContext
const sha = (c: string) => c.repeat(64)

let root: string
let state: string
let folder: string
let store: HostStore
let standby: boolean
let leaves: number

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'p4a-')))
  state = join(root, 'state')
  folder = join(root, 'repo')
  await mkdir(folder)
  store = await openStore(state, uid)
  store.syncRepositories([folder])
  standby = true
  leaves = 0
})
afterEach(async () => {
  store.close()
  await rm(root, { recursive: true, force: true })
})

/** Puts `folder` (a file the importer owns outside state.sqlite) beside the lanes it imports. */
function laneImporters(
  sideFile = join(root, 'side.txt'),
): MigrationImporters & { applied: number } {
  const importers = {
    applied: 0,
    lanes: {
      apply: async (section: { items: readonly MigrationLaneItem[] }) => {
        importers.applied++
        await writeFile(sideFile, 'imported')
        const repositoryId = store.listRepositories()[0]?.id ?? ''
        for (const item of section.items)
          store.ensureLane({ repositoryId, cwd: item.cwd, sessionFile: item.sessionFile })
      },
      snapshot: async (into: string) => {
        await writeFile(join(into, 'side.txt'), await readFile(sideFile).catch(() => 'none'))
      },
      restore: async (from: string) => {
        await writeFile(sideFile, await readFile(join(from, 'side.txt')))
      },
    },
  }
  return importers
}

function migration(
  importers: MigrationImporters = {},
  overrides: Partial<OwnerMigrationPorts> = {},
) {
  const refresh = vi.fn(async () => {})
  const created = createOwnerMigration({
    stateDirectory: state,
    uid,
    store,
    daemon: {
      standby: () => standby,
      leaveStandby: async () => {
        leaves++
        standby = false
      },
    },
    importers,
    refresh,
    now: () => 1_000,
    log: () => {},
    ...overrides,
  })
  const h = created.handlers
  return {
    refresh,
    recover: created.recover,
    begin: (id: string) =>
      h['owner.migrate.begin']({ migrationId: id, desktopVersion: '1.2.3' }, call),
    status: (id: string) => h['owner.migrate.status']({ migrationId: id }, call),
    commit: (id: string) => h['owner.migrate.commit']({ migrationId: id }, call),
    abort: (id: string) => h['owner.migrate.abort']({ migrationId: id }, call),
    import: (params: MigrationImport) => h['owner.migrate.import'](params, call),
  }
}

function lanesSection(id: string, files: string[], hash = sha('a')): MigrationImport {
  return {
    migrationId: id,
    hash,
    section: 'lanes',
    items: files.map((sessionFile): MigrationLaneItem => ({
      laneId: randomUUID(),
      sessionFile,
      cwd: folder,
      rootPath: folder,
      worktree: false,
      title: null,
      branch: null,
      model: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })),
  }
}

const refused = (message: string) => expect.objectContaining({ code: 'forbidden', message })

describe('owner.migrate.begin', () => {
  it('stages once, returns the same state for the same id, and refuses a second id', async () => {
    const m = migration()
    const id = randomUUID()
    expect(await m.begin(id)).toEqual({ state: 'staged' })
    expect(await m.begin(id)).toEqual({ state: 'staged' })
    expect(existsSync(join(state, 'owner-migration', id, 'state.sqlite'))).toBe(true)
    await expect(m.begin(randomUUID())).rejects.toEqual(refused('Another migration is staged.'))
    expect(MIGRATION_REFUSALS.otherStaged).toBe('Another migration is staged.')
  })

  it('is refused outside standby', async () => {
    standby = false
    await expect(migration().begin(randomUUID())).rejects.toEqual(
      refused(MIGRATION_REFUSALS.notStandby),
    )
  })
})

describe('owner.migrate.import', () => {
  it('applies a section once; the same hash and content replays as a no-op', async () => {
    const importers = laneImporters()
    const m = migration(importers)
    const id = randomUUID()
    await m.begin(id)
    const section = lanesSection(id, [join(folder, 'a.jsonl')])
    expect(await m.import(section)).toEqual({ staged: true, replayed: false })
    expect(await m.import(section)).toEqual({ staged: true, replayed: true })
    expect(importers.applied).toBe(1)
    await expect(m.import({ ...section, hash: sha('b') })).rejects.toEqual(
      refused(MIGRATION_REFUSALS.restaged),
    )
    await expect(m.import(lanesSection(id, [join(folder, 'b.jsonl')]))).rejects.toEqual(
      refused(MIGRATION_REFUSALS.restaged),
    )
    expect(importers.applied).toBe(1)
  })

  it('answers unsupported for a section without an importer, and refuses an unstaged id', async () => {
    const m = migration()
    const id = randomUUID()
    await m.begin(id)
    await expect(m.import(lanesSection(id, []))).rejects.toMatchObject({ code: 'unsupported' })
    await expect(m.import(lanesSection(randomUUID(), []))).rejects.toEqual(
      refused(MIGRATION_REFUSALS.notStaged),
    )
  })

  it('an importer failure stages nothing, so the retry applies again', async () => {
    let fail = true
    const m = migration({
      lanes: {
        apply: async () => {
          if (fail) throw new OwnerCallRefused('bad-request', 'nope')
        },
      },
    })
    const id = randomUUID()
    await m.begin(id)
    await expect(m.import(lanesSection(id, []))).rejects.toMatchObject({ code: 'bad-request' })
    fail = false
    expect(await m.import(lanesSection(id, []))).toEqual({ staged: true, replayed: false })
  })
})

describe('owner.migrate.abort', () => {
  it('restores the begin snapshot: the store sees the import and then the abort without a restart', async () => {
    const side = join(root, 'side.txt')
    await writeFile(side, 'before')
    const before = store.ensureLane({
      repositoryId: store.listRepositories()[0]?.id ?? '',
      cwd: folder,
      sessionFile: join(folder, 'before.jsonl'),
    })
    store.setLaneMarks(before.laneId, { pinned: true })
    const m = migration(laneImporters(side))
    const id = randomUUID()
    await m.begin(id)
    store.setLaneMarks(before.laneId, { pinned: false })
    await m.import(lanesSection(id, [join(folder, 'a.jsonl'), join(folder, 'b.jsonl')]))
    expect(store.listLanes()).toHaveLength(3)
    expect(await readFile(side, 'utf8')).toBe('imported')

    expect(await m.abort(id)).toEqual({ state: 'aborted' })
    expect(store.listLanes().map((l) => [l.laneId, l.pinned])).toEqual([[before.laneId, true]])
    expect(await readFile(side, 'utf8')).toBe('before')
    expect(m.refresh).toHaveBeenCalledOnce()
    expect(existsSync(join(state, 'owner-migration', id))).toBe(false)
    expect(await m.status(id)).toEqual({ state: 'aborted' })
    expect(await m.abort(id)).toEqual({ state: 'aborted' })
    await expect(m.commit(id)).rejects.toEqual(refused(MIGRATION_REFUSALS.aborted))
    // A new attempt may begin once this one is aborted.
    expect(await m.begin(randomUUID())).toEqual({ state: 'staged' })
  })

  it('never empties the state when the begin snapshot is gone', async () => {
    const m = migration({ lanes: { apply: laneImporters().lanes.apply } })
    const id = randomUUID()
    await m.begin(id)
    await m.import(lanesSection(id, [join(folder, 'a.jsonl')]))
    await rm(join(state, 'owner-migration', id, 'state.sqlite'))
    await expect(m.abort(id)).rejects.toThrow()
    expect(store.listLanes()).toHaveLength(1)
    expect(store.listRepositories()).toHaveLength(1)
    expect(await m.status(id)).toEqual({ state: 'staged' })
  })

  it('answers none for an unknown id and refuses a committed one', async () => {
    const m = migration()
    expect(await m.abort(randomUUID())).toEqual({ state: 'none' })
    expect(await m.status(randomUUID())).toEqual({ state: 'none' })
    const id = randomUUID()
    await m.begin(id)
    await m.commit(id)
    await expect(m.abort(id)).rejects.toEqual(refused(MIGRATION_REFUSALS.committed))
  })
})

describe('owner.migrate.commit', () => {
  it('is durable across a restart, leaves standby once, and removes the snapshot after', async () => {
    const m = migration(laneImporters())
    const id = randomUUID()
    await m.begin(id)
    await m.import(lanesSection(id, [join(folder, 'a.jsonl')]))
    expect(await m.commit(id)).toEqual({ state: 'committed' })
    expect(leaves).toBe(1)
    expect(existsSync(join(state, 'owner-migration', id))).toBe(false)
    expect(await m.commit(id)).toEqual({ state: 'committed' })
    expect(leaves).toBe(1)

    store.close()
    store = await openStore(state, uid)
    const restarted = migration()
    await restarted.recover()
    expect(leaves).toBe(1)
    expect(await restarted.status(id)).toEqual({ state: 'committed' })
    expect(store.listLanes()).toHaveLength(1)
    const staging = await withMigrationRecords(state, uid, Date.now, (r) => r.staged(id, 'lanes'))
    expect(staging).toBeNull()
  })

  it('a crash after the durable commit rolls forward at the next start, and keeps the snapshot until then', async () => {
    const id = randomUUID()
    const crashing = migration(
      {},
      {
        daemon: {
          standby: () => standby,
          leaveStandby: async () => {
            throw new Error('power lost')
          },
        },
      },
    )
    await crashing.begin(id)
    await expect(crashing.commit(id)).rejects.toThrow('power lost')
    expect(standby).toBe(true)
    expect(await crashing.status(id)).toEqual({ state: 'committed' })
    expect(existsSync(join(state, 'owner-migration', id))).toBe(true)

    const restarted = migration()
    await restarted.recover()
    expect(leaves).toBe(1)
    expect(standby).toBe(false)
    expect(existsSync(join(state, 'owner-migration', id))).toBe(false)
  })

  it('a later standby is never left for a migration that already rolled forward', async () => {
    const m = migration()
    const id = randomUUID()
    await m.begin(id)
    await m.commit(id)
    standby = true
    await migration().recover()
    expect(leaves).toBe(1)
    expect(standby).toBe(true)
  })

  it('a crash before the commit leaves the attempt staged for Desktop to abort', async () => {
    const id = randomUUID()
    await migration(laneImporters()).begin(id)
    await migration(laneImporters()).import(lanesSection(id, [join(folder, 'a.jsonl')]))
    // Desktop restarts, reads status from a new connection and aborts.
    const desktop = migration(laneImporters())
    await desktop.recover()
    expect(await desktop.status(id)).toEqual({ state: 'staged' })
    expect(standby).toBe(true)
    expect(await desktop.abort(id)).toEqual({ state: 'aborted' })
    expect(store.listLanes()).toEqual([])
    expect(leaves).toBe(0)
  })
})

describe('recover', () => {
  it('removes a snapshot folder left by a begin that crashed before its row', async () => {
    const orphan = join(state, 'owner-migration', randomUUID())
    await mkdir(orphan, { recursive: true })
    await writeFile(join(orphan, 'state.sqlite'), '')
    const m = migration()
    const staged = randomUUID()
    await m.begin(staged)
    await m.recover()
    expect(existsSync(orphan)).toBe(false)
    expect(existsSync(join(state, 'owner-migration', staged))).toBe(true)
  })
})
