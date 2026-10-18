import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { loadSqlite } from './sqlite'
import { HostStore, openStore } from './store'

let root: string
let store: HostStore
let db: DatabaseSync
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'host-row-contract-'))
  store = await openStore(join(root, 'state'), process.getuid?.())
  const { DatabaseSync } = await loadSqlite()
  db = new DatabaseSync(join(root, 'state', 'state.sqlite'))
})
afterEach(() => {
  vi.restoreAllMocks()
  db.close()
  store.close()
  rmSync(root, { recursive: true, force: true })
})

it.each([-1, 9007199254740992])(
  'skips corrupt integer %s with count-only logging even when it throws',
  (value) => {
    const path = join(root, 'repository')
    mkdirSync(path)
    const repository = store.syncRepositories([path])[0]
    if (!repository) throw new Error('missing repository')
    const lane = store.ensureLane({ repositoryId: repository.id, cwd: path, sessionFile: null })
    db.exec('PRAGMA ignore_check_constraints=ON')
    db.prepare('UPDATE lanes SET attention=?').run(value)
    db.prepare('UPDATE repositories SET added_at=?').run(value)
    const log = vi.fn((_count: number) => {
      throw new Error('private logger failure')
    })
    const tested = new HostStore(db, { logCorruptLane: log })
    expect(tested.listLanes()).toEqual([])
    expect(tested.getLane(lane.laneId)).toBeNull()
    expect(tested.listRepositories()).toEqual([])
    expect(log.mock.calls).toEqual([[1], [1], [1]])
  },
)

it('closes the database when newer state or store construction is refused', async () => {
  const { DatabaseSync } = await loadSqlite()
  const close = vi.spyOn(DatabaseSync.prototype, 'close')
  db.exec('PRAGMA user_version=2')
  await expect(openStore(join(root, 'state'), process.getuid?.())).rejects.toMatchObject({
    exitCode: 78,
    message: expect.stringContaining('newer Host'),
  })
  expect(close).toHaveBeenCalledTimes(1)
  db.exec('PRAGMA user_version=1')
  await expect(
    openStore(join(root, 'state'), process.getuid?.(), { receiptTtlMs: 0 }),
  ).rejects.toMatchObject({ exitCode: 70 })
  expect(close).toHaveBeenCalledTimes(2)
})

it.each(['ENOENT', 'ENOTDIR', 'EACCES'])(
  'skips only expected repository errors including %s',
  (code) => {
    const unavailable = vi.fn()
    const realpath = vi.spyOn(realpathSync, 'native')
    realpath.mockImplementationOnce(() => {
      throw Object.assign(new Error('private path'), { code })
    })
    expect(store.syncRepositories([join(root, 'repository')], unavailable)).toEqual([])
    expect(unavailable.mock.calls).toEqual([[1]])
    const unexpected = Object.assign(new Error('unexpected I/O'), { code: 'EIO' })
    realpath.mockImplementationOnce(() => {
      throw unexpected
    })
    expect(() => store.syncRepositories([join(root, randomUUID())])).toThrow(unexpected)
    realpath.mockImplementationOnce(() => {
      throw { code }
    })
    expect(() => store.syncRepositories([join(root, 'repository')])).toThrow()
  },
)
