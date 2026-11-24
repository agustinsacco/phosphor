import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { HOST_SIDECARS } from '@phosphor/shared/host-local'
import { fakeMachine } from '../../__fixtures__/machine'
import { loadHostConfig } from '../../config/load'
import { baseOpenStoreDatabase } from '../__fixtures__/base-684cb3478/open'
import { SCHEMA } from '../schema'
import { HostStore, openStore } from '../store'
import { ADDITIVE_TABLES } from './additive'
import { LANE_ARCHIVES_SCHEMA } from './archives'
import { LANE_MARKS_SCHEMA } from './marks'

const uid = process.getuid?.()
let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'host-additive-')))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** Every sidecar a later Host may keep, in both folders an older Host checks. */
function writeSidecars(directory: string) {
  for (const name of Object.values(HOST_SIDECARS))
    writeFileSync(join(directory, name), '{"version":1,"future":true}\n', { mode: 0o600 })
}

// The frozen open path imports these; HostStore is also unchanged since 684cb3478 but for imports.
it('keeps the schemas the frozen 684cb3478 open path runs at their released text', () => {
  const digest = createHash('sha256')
    .update(SCHEMA)
    .update(LANE_MARKS_SCHEMA)
    .update(LANE_ARCHIVES_SCHEMA)
    .digest('hex')
  expect(digest).toBe('ea251a5a17c44831e83ddb787e925e880c20140a8c4ce7ff8973223436b9f483')
})

it('lets the 684cb3478 Host open state holding every additive table and sidecar', async () => {
  const state = join(root, 'state')
  const store = await openStore(state, uid)
  const repository = join(root, 'repository')
  mkdirSync(repository)
  const [entry] = store.syncRepositories([repository])
  const lane = store.ensureLane({
    repositoryId: entry!.id,
    cwd: repository,
    sessionFile: join(root, 'lane.jsonl'),
  })
  const db = (store as unknown as { db: DatabaseSync }).db
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all()
    .map((row) => row.name)
  expect(tables).toEqual(expect.arrayContaining([...ADDITIVE_TABLES]))
  db.prepare(`INSERT INTO lane_prefs VALUES (?, 'lineage', '1')`).run(lane.laneId)
  db.prepare(`INSERT INTO lane_pauses VALUES (?, 'service-update', 1, 'idle')`).run(lane.laneId)
  db.prepare(`INSERT INTO owner_migrations VALUES ('m', 'staged', 1, 1, NULL)`).run()
  db.prepare(`INSERT INTO owner_migration_staging VALUES ('m', 'lanes', 'd', '{}', 1)`).run()
  db.prepare(
    `INSERT INTO agent_jobs VALUES ('j', 'local', 'package.install', 'running', NULL, NULL, 1, 1)`,
  ).run()
  store.close()
  writeSidecars(state)

  const old = await baseOpenStoreDatabase(
    state,
    uid,
    {},
    (handle, ports) => new HostStore(handle, ports),
  )
  try {
    expect(old.listLanes().map((row) => row.laneId)).toEqual([lane.laneId])
    old.markRemoved(lane.laneId)
    old.pruneRemovedLanes(Number.MAX_SAFE_INTEGER)
    expect(old.listLanes()).toEqual([])
    const oldDb = (old as unknown as { db: DatabaseSync }).db
    expect(oldDb.prepare('SELECT count(*) AS n FROM lane_prefs').get()?.n).toBe(0)
    expect(oldDb.prepare('SELECT count(*) AS n FROM lane_pauses').get()?.n).toBe(0)
    expect(oldDb.prepare('PRAGMA user_version').get()?.user_version).toBe(1)
  } finally {
    old.close()
  }
  const reopened = await openStore(state, uid)
  reopened.close()
})

// config/load.ts is unchanged since 684cb3478, so today's loader is the released one.
it('lets the 684cb3478 config loader read config.json beside every sidecar', async () => {
  const machine = fakeMachine()
  try {
    writeSidecars(dirname(machine.configPath))
    const loaded = await loadHostConfig(machine.configPath, uid)
    expect(loaded).toMatchObject({ ok: true })
  } finally {
    rmSync(machine.dir, { recursive: true, force: true })
  }
})
