import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadSqlite } from '../sqlite'
import { prepareStateFile } from '../state-dir'
import { openStore, type HostStore } from '../store'
import { readModelScans, writeModelScans } from './model-scans'

const uid = process.getuid?.()
let root: string
let state: string
let store: HostStore
let laneId: string
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'host-model-scans-')))
  state = join(root, 'state')
  const repository = join(root, 'repository')
  mkdirSync(repository)
  store = await openStore(state, uid)
  const [entry] = store.syncRepositories([repository])
  laneId = store.ensureLane({
    repositoryId: entry!.id,
    cwd: repository,
    sessionFile: join(root, 'lane.jsonl'),
  }).laneId
})
afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

async function prefs(): Promise<Record<string, string>[]> {
  const sqlite = await loadSqlite()
  const db = new sqlite.DatabaseSync(prepareStateFile(state, uid))
  try {
    return db
      .prepare('SELECT lane_id, key, value FROM lane_prefs ORDER BY lane_id, key')
      .all()
      .map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, String(v)])))
  } finally {
    db.close()
  }
}

describe('model scans', () => {
  it('live in state.sqlite’s lane_prefs, so purge removes them with it on any version', async () => {
    expect(await readModelScans(state, uid)).toEqual(new Map())
    await writeModelScans(state, uid, new Map([[laneId, 'none:120:1735689600000']]))
    expect(await readModelScans(state, uid)).toEqual(new Map([[laneId, 'none:120:1735689600000']]))
    expect(await prefs()).toEqual([
      { lane_id: laneId, key: 'model_scan', value: 'none:120:1735689600000' },
    ])
    expect(readdirSync(state).filter((name) => !name.startsWith('state.sqlite'))).toEqual([])
  })

  it('replaces the remembered set, and drops a value it does not know', async () => {
    await writeModelScans(state, uid, new Map([[laneId, 'capped:1:2']]))
    await writeModelScans(state, uid, new Map())
    expect(await prefs()).toEqual([])
    await writeModelScans(state, uid, new Map([[laneId, 'bogus']]))
    expect(await readModelScans(state, uid)).toEqual(new Map())
  })
})
