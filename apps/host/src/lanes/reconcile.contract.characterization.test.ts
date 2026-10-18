import { randomUUID } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HOST_LIMITS } from '@phosphor/shared/host-protocol'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import { openStore, type HostStore } from './store'
import { loadSqlite } from './sqlite'
import { reconcile, RECONCILE_LIMITS } from './reconcile'

let root: string
let repository: string
let repositoryId: string
let store: HostStore
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'host-reconcile-'))
  repository = join(root, 'repo')
  mkdirSync(repository)
  // The path helper realpaths cwd, including macOS /var -> /private/var.
  const { realpathSync } = await import('node:fs')
  root = realpathSync.native(root)
  repository = realpathSync.native(repository)
  store = await openStore(join(root, 'state'), process.getuid?.())
  const entry = store.syncRepositories([repository])[0]
  if (!entry) throw new Error('no repository')
  repositoryId = entry.id
})
afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})
const scan = (log?: (skipped: number) => void) => reconcile(store, join(root, 'sessions'), log)
function session(cwd = repository, header: unknown = { type: 'session', id: randomUUID(), cwd }) {
  const directory = sessionDirForCwd(cwd, join(root, 'sessions'))
  mkdirSync(directory, { recursive: true })
  const file = join(directory, `${randomUUID()}.jsonl`)
  writeFileSync(
    file,
    JSON.stringify(header) + '\n' + '{invalid transcript messages are not parsed}\n',
  )
  return file
}
it('stops between session files on abort, leaving settled upserts but no partial report', async () => {
  session()
  session()
  const controller = new AbortController()
  const ensure = store.ensureLane.bind(store)
  const spy = vi.spyOn(store, 'ensureLane').mockImplementation((input) => {
    const lane = ensure(input)
    controller.abort()
    return lane
  })
  const log = vi.fn()
  try {
    const failure: unknown = await reconcile(
      store,
      join(root, 'sessions'),
      log,
      controller.signal,
    ).catch((error: unknown) => error)
    expect(controller.signal.aborted).toBe(true)
    expect(failure).toBe(controller.signal.reason)
    expect(store.listLanes()).toHaveLength(1)
    expect(log).not.toHaveBeenCalled()
  } finally {
    spy.mockRestore()
  }
})
it('revives the same lane through an aliased cwd after deletion and reappearance', async () => {
  const cwd = join(repository, '.phosphor', 'worktrees', 'topic')
  mkdirSync(cwd, { recursive: true })
  const alias = join(root, 'alias')
  symlinkSync(cwd, alias)
  const file = session(cwd)
  const lane = store.ensureLane({ repositoryId, cwd: alias, sessionFile: file, worktree: true })
  expect((await scan()).added).toBe(0)
  unlinkSync(file)
  expect((await scan()).removed).toBe(1)
  expect(store.getLane(lane.laneId)?.removedAt).not.toBeNull()
  writeFileSync(file, JSON.stringify({ type: 'session', id: randomUUID(), cwd }) + '\n')
  expect((await scan()).added).toBe(1)
  expect(store.sessionLane(file)).toMatchObject({
    laneId: lane.laneId,
    cwd: alias,
    removedAt: null,
  })
})
it('scans exactly 256 worktree directories and reports a skipped scan for the 257th', async () => {
  const directory = join(repository, '.phosphor', 'worktrees')
  for (let i = 0; i < RECONCILE_LIMITS.worktreesPerRepository; i++) {
    const cwd = join(directory, `${i}`)
    mkdirSync(cwd, { recursive: true })
    session(cwd)
  }
  const skipped: number[] = []
  expect((await scan((count) => skipped.push(count))).added).toBe(
    RECONCILE_LIMITS.worktreesPerRepository,
  )
  expect(skipped).toEqual([])
  // No live lane names these cwds; the discovery cap must be independent of the index.
  for (const lane of store.listLanes()) store.markRemoved(lane.laneId)
  const cwd = join(directory, 'extra')
  mkdirSync(cwd)
  session(cwd)
  expect((await scan((count) => skipped.push(count))).added).toBe(
    RECONCILE_LIMITS.worktreesPerRepository,
  )
  expect(skipped).toEqual([1])
})
it('skips unreadable or unsafe folders without treating known files as removed', async () => {
  const file = session()
  await scan()
  const directory = sessionDirForCwd(repository, join(root, 'sessions'))
  const { renameSync } = await import('node:fs')
  renameSync(directory, directory + '-aside')
  symlinkSync(directory + '-aside', directory)
  const skipped: number[] = []
  expect(await scan((count) => skipped.push(count))).toMatchObject({ removed: 0 })
  expect(store.sessionLane(file)?.removedAt).toBeNull()
  expect(skipped).toEqual([1])
})

it('accepts exactly 8192 header bytes and skips one byte past it', async () => {
  const header = { type: 'session', id: randomUUID(), cwd: repository, pad: '' }
  const padding = 8192 - Buffer.byteLength(JSON.stringify(header))
  session(repository, { ...header, pad: 'x'.repeat(padding) })
  session(repository, { ...header, pad: 'x'.repeat(padding + 1) })
  const skipped: number[] = []
  expect((await scan((count) => skipped.push(count))).added).toBe(1)
  expect(skipped).toEqual([1])
})
it('bounds additions at the lane cap and bounds directory iteration', async () => {
  for (let i = 0; i < HOST_LIMITS.lanesPerHost; i++)
    store.ensureLane({ repositoryId, cwd: repository, sessionFile: null })
  const file = session()
  const skipped: number[] = []
  expect((await scan((count) => skipped.push(count))).added).toBe(0)
  expect(store.sessionLane(file)).toBeNull()
  expect(skipped).toEqual([1])
  unlinkSync(file)
  const directory = sessionDirForCwd(repository, join(root, 'sessions'))
  for (let i = 0; i <= HOST_LIMITS.lanesPerHost * 2; i++)
    writeFileSync(join(directory, `${i}.txt`), '')
  expect((await scan((count) => skipped.push(count))).removed).toBe(0)
  expect(skipped).toEqual([1, 1])
})

it('removes vanished files before admitting replacements at capacity in one reconcile', async () => {
  store.close()
  store = await openStore(join(root, 'state'), process.getuid?.(), { limits: { lanesPerHost: 1 } })
  const old = session()
  await scan()
  const oldId = store.sessionLane(old)?.laneId
  unlinkSync(old)
  const replacement = session()
  expect(await scan()).toEqual({ repositories: 1, lanes: 1, added: 1, removed: 1 })
  expect(store.listLanes().map((lane) => lane.sessionFile)).toEqual([replacement])
  expect(store.sessionLane(old)?.removedAt).not.toBeNull()
  expect(store.sessionLane(replacement)?.laneId).not.toBe(oldId)
})

it('uses the SQL cap when corrupt live rows make the cached count read low', async () => {
  store.close()
  store = await openStore(join(root, 'state'), process.getuid?.(), { limits: { lanesPerHost: 2 } })
  const original = session()
  await scan()
  const { DatabaseSync } = await loadSqlite()
  const db = new DatabaseSync(join(root, 'state', 'state.sqlite'))
  try {
    db.exec('PRAGMA ignore_check_constraints=ON')
    db.prepare('UPDATE lanes SET title=? WHERE session_file=?').run('private\ntext', original)
    unlinkSync(original)
    const candidates = [session(), session()]
    const skipped: number[] = []
    expect((await scan((count) => skipped.push(count))).added).toBe(1)
    expect(store.listLanes()).toHaveLength(1)
    expect(candidates.filter((file) => store.sessionLane(file) !== null)).toHaveLength(1)
    expect(skipped).toEqual([1])
    expect(
      db.prepare('SELECT count(*) AS count FROM lanes WHERE removed_at IS NULL').get()?.count,
    ).toBe(2)
  } finally {
    db.close()
  }
})

it('does not treat ENOTDIR on an exact known session path as deletion proof', async () => {
  const file = session()
  await scan()
  const directory = sessionDirForCwd(repository, join(root, 'sessions'))
  renameSync(directory, directory + '-aside')
  writeFileSync(directory, 'not a directory')
  const log = vi.fn()
  expect(await scan(log)).toEqual({ repositories: 1, lanes: 1, added: 0, removed: 0 })
  expect(store.sessionLane(file)?.removedAt).toBeNull()
  expect(log).toHaveBeenCalledExactlyOnceWith(2)
})

it('does not count a concurrently admitted live row against the cached addition cap', async () => {
  const first = session()
  const second = session()
  const lookup = store.sessionLane.bind(store)
  const reads = new Map<string, number>()
  const lookupSpy = vi.spyOn(store, 'sessionLane').mockImplementation((file) => {
    const count = (reads.get(file) ?? 0) + 1
    reads.set(file, count)
    if (count === 2 && store.listLanes().length === 0)
      store.ensureLane({ repositoryId, cwd: repository, sessionFile: file })
    return lookup(file)
  })
  try {
    expect(await scan()).toEqual({ repositories: 1, lanes: 2, added: 1, removed: 0 })
    expect(lookup(first)?.removedAt).toBeNull()
    expect(lookup(second)?.removedAt).toBeNull()
  } finally {
    lookupSpy.mockRestore()
  }
})
