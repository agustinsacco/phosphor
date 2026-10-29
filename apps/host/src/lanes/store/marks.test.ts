import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadSqlite } from '../sqlite'
import { SCHEMA, SCHEMA_VERSION } from '../schema'
import { prepareStateDirectory, prepareStateFile } from '../state-dir'
import { openStore, REMOVED_LANE_TTL_MS, type HostStore } from '../store'

let root: string
let directory: string
let repository: string
let now: number
const handles: HostStore[] = []
const uid = process.getuid?.()
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'host-marks-'))
  directory = join(root, 'state')
  repository = join(root, 'repository')
  mkdirSync(repository)
  now = 1000
})
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close()
  rmSync(root, { recursive: true, force: true })
})
async function open(): Promise<HostStore> {
  const store = await openStore(directory, uid, { now: () => now })
  handles.push(store)
  return store
}
function close(store: HostStore): void {
  store.close()
  handles.splice(handles.indexOf(store), 1)
}
function addLane(store: HostStore, file = 'a.jsonl') {
  const [entry] = store.syncRepositories([repository])
  if (!entry) throw new Error('missing repository')
  return store.ensureLane({
    repositoryId: entry.id,
    cwd: repository,
    sessionFile: join(root, file),
  })
}
async function query<T>(
  read: (db: InstanceType<Awaited<ReturnType<typeof loadSqlite>>['DatabaseSync']>) => T,
) {
  const { DatabaseSync } = await loadSqlite()
  const db = new DatabaseSync(join(directory, 'state.sqlite'))
  try {
    return read(db)
  } finally {
    db.close()
  }
}
const markRows = () => query((db) => db.prepare('SELECT count(*) AS n FROM lane_marks').get()?.n)

describe('lane marks storage', () => {
  it('adds the marks table to an existing version-1 database without a schema bump', async () => {
    prepareStateDirectory(directory, uid)
    prepareStateFile(directory, uid)
    await query((db) => db.exec(SCHEMA))
    const store = await open()
    const lane = addLane(store)
    expect(lane).not.toHaveProperty('pinned')
    expect(lane).not.toHaveProperty('marker')
    expect(SCHEMA_VERSION).toBe(1)
    expect(
      await query((db) => [
        db.prepare('PRAGMA user_version').get()?.user_version,
        db.prepare("SELECT strict FROM pragma_table_list WHERE name='lane_marks'").get()?.strict,
      ]),
    ).toEqual([1, 1])
  })

  it('persists marks across a reopen and leaves updatedAt alone', async () => {
    let store = await open()
    const lane = addLane(store)
    now = 5000
    expect(store.setLaneMarks(lane.laneId, { pinned: true, marker: '👨‍👩‍👧‍👦' })).toMatchObject({
      pinned: true,
      marker: '👨‍👩‍👧‍👦',
      updatedAt: lane.updatedAt,
    })
    close(store)
    store = await open()
    expect(store.getLane(lane.laneId)).toMatchObject({ pinned: true, marker: '👨‍👩‍👧‍👦' })
    expect(store.listLanes()[0]).toMatchObject({ pinned: true, marker: '👨‍👩‍👧‍👦' })
    store.setLaneMarks(lane.laneId, { pinned: false, marker: null })
    expect(await markRows()).toBe(0)
  })

  it('refuses a mark the table would refuse, and a removed lane', async () => {
    const store = await open()
    const lane = addLane(store)
    expect(() => store.setLaneMarks(lane.laneId, {})).toThrow()
    expect(() => store.setLaneMarks(lane.laneId, { marker: 'x'.repeat(33) })).toThrow()
    expect(() => store.setLaneMarks(lane.laneId, { marker: 'a\nb' })).toThrow()
    store.markRemoved(lane.laneId)
    expect(() => store.setLaneMarks(lane.laneId, { pinned: true })).toThrow()
  })

  it('removes a lane row’s marks with the row', async () => {
    const store = await open()
    const lane = addLane(store)
    store.setLaneMarks(lane.laneId, { pinned: true })
    store.markRemoved(lane.laneId)
    expect(await markRows()).toBe(1)
    store.pruneRemovedLanes(now + REMOVED_LANE_TTL_MS + 1)
    expect(store.getLane(lane.laneId)).toBeNull()
    expect(await markRows()).toBe(0)
  })
})
