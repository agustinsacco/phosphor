import { randomUUID } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import type { ScanState } from '../reconcile'
import { openStore, type HostStore } from '../store'
import { admitSessions, hasHeader, removeMissingSessions } from './sessions'

let root: string
let cwd: string
let repositoryId: string
let sessionsRoot: string
let store: HostStore
let state: ScanState
beforeEach(async () => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'host-reconcile-sessions-')))
  cwd = join(root, 'repo')
  sessionsRoot = join(root, 'sessions')
  mkdirSync(cwd)
  store = await openStore(join(root, 'state'), process.getuid?.(), { limits: { lanesPerHost: 2 } })
  const repositories = store.syncRepositories([cwd])
  repositoryId = repositories[0]!.id
  state = {
    repositories,
    known: [],
    folders: new Map([[cwd, repositoryId]]),
    added: 0,
    removed: 0,
    skipped: 0,
    liveLanes: 0,
    admissionsFull: false,
  }
})
afterEach(() => {
  vi.restoreAllMocks()
  store.close()
  rmSync(root, { recursive: true, force: true })
})
function session(header: unknown = { type: 'session', id: randomUUID(), cwd }) {
  const directory = sessionDirForCwd(cwd, sessionsRoot)
  mkdirSync(directory, { recursive: true })
  const file = join(directory, `${randomUUID()}.jsonl`)
  writeFileSync(file, JSON.stringify(header) + '\ninvalid transcript\n')
  return file
}

it('accepts a header of exactly 8192 bytes and refuses a longer first line', async () => {
  const header = { type: 'session', id: randomUUID(), cwd, pad: '' }
  const padding = 8192 - Buffer.byteLength(JSON.stringify(header))
  expect(await hasHeader(session({ ...header, pad: 'x'.repeat(padding) }), cwd)).toBe(true)
  expect(await hasHeader(session({ ...header, pad: 'x'.repeat(padding + 1) }), cwd)).toBe(false)
})

it.each([
  null,
  { type: 'message', id: randomUUID() },
  { type: 'session', id: 'invalid' },
  { type: 'session', id: randomUUID(), cwd: '/wrong' },
])('refuses an invalid header %j', async (header) => {
  expect(await hasHeader(session(header), cwd)).toBe(false)
})

it('requires a complete JSON first line and refuses symlinks and directories', async () => {
  const file = session()
  writeFileSync(file, '{}')
  expect(await hasHeader(file, cwd)).toBe(false)
  writeFileSync(file, 'not JSON\n')
  await expect(hasHeader(file, cwd)).rejects.toBeInstanceOf(SyntaxError)
  const link = join(root, 'link')
  symlinkSync(file, link)
  await expect(hasHeader(link, cwd)).rejects.toMatchObject({ code: 'ELOOP' })
  expect(await hasHeader(root, cwd)).toBe(false)
})

it('removes only exact missing files and ignores ENOTDIR, null files and inactive rows', async () => {
  const missing = session()
  const lane = store.ensureLane({ repositoryId, cwd, sessionFile: missing })
  const unsaved = store.ensureLane({ repositoryId, cwd, sessionFile: null })
  state.known = store.listLanes()
  state.known.push({ ...lane, repositoryId: '0000000000000000', laneId: randomUUID() })
  const directory = sessionDirForCwd(cwd, sessionsRoot)
  renameSync(directory, directory + '-aside')
  writeFileSync(directory, '')
  await removeMissingSessions(store, state)
  expect(state).toMatchObject({ removed: 0, skipped: 1 })
  expect(store.getLane(lane.laneId)?.removedAt).toBeNull()
  unlinkSync(directory)
  await removeMissingSessions(store, state)
  expect(state.removed).toBe(1)
  expect(store.getLane(unsaved.laneId)?.removedAt).toBeNull()
})

it('revives an aliased cwd without changing the lane identity', async () => {
  const file = session()
  const alias = join(root, 'alias')
  symlinkSync(cwd, alias)
  const lane = store.ensureLane({ repositoryId, cwd: alias, sessionFile: file })
  store.markRemoved(lane.laneId)
  await admitSessions(store, state, sessionsRoot)
  expect(store.sessionLane(file)).toMatchObject({
    laneId: lane.laneId,
    cwd: alias,
    removedAt: null,
  })
  expect(state).toMatchObject({ added: 1, liveLanes: 1, skipped: 0 })
})

it('skips revival when the stored cwd differs from the discovered folder', async () => {
  const file = session()
  const other = join(root, 'other')
  mkdirSync(other)
  const lane = store.ensureLane({ repositoryId, cwd: other, sessionFile: file })
  store.markRemoved(lane.laneId)
  await admitSessions(store, state, sessionsRoot)
  expect(state).toMatchObject({ added: 0, skipped: 1 })
  expect(store.getLane(lane.laneId)?.removedAt).not.toBeNull()
})

it('stops at the cached cap without attempting SQL admission', async () => {
  session()
  state.liveLanes = store.limits.lanesPerHost
  const ensure = vi.spyOn(store, 'ensureLane')
  await admitSessions(store, state, sessionsRoot)
  expect(ensure).not.toHaveBeenCalled()
  expect(state).toMatchObject({ added: 0, skipped: 1, admissionsFull: true })
})

it('stops at the SQL cap even when the cached count is low', async () => {
  for (let i = 0; i < store.limits.lanesPerHost; i++)
    store.ensureLane({ repositoryId, cwd, sessionFile: null })
  session()
  session()
  const ensure = vi.spyOn(store, 'ensureLane')
  await admitSessions(store, state, sessionsRoot)
  expect(ensure).toHaveBeenCalledTimes(1)
  expect(state).toMatchObject({ added: 0, skipped: 1, admissionsFull: true })
})

it('reads wasLive and ensures the lane in the same synchronous admission step', async () => {
  session()
  const lookup = store.sessionLane.bind(store)
  const ensure = store.ensureLane.bind(store)
  const order: string[] = []
  let reads = 0
  vi.spyOn(store, 'sessionLane').mockImplementation((file) => {
    if (++reads === 2) {
      order.push('read')
      queueMicrotask(() => order.push('microtask'))
    }
    return lookup(file)
  })
  vi.spyOn(store, 'ensureLane').mockImplementation((input) => {
    order.push('ensure')
    return ensure(input)
  })
  await admitSessions(store, state, sessionsRoot)
  expect(order).toEqual(['read', 'ensure', 'microtask'])
  expect(state.added).toBe(1)
})

it('preserves settled admissions and removals when the next checkpoint aborts', async () => {
  const file = session()
  session()
  const controller = new AbortController()
  const ensure = store.ensureLane.bind(store)
  vi.spyOn(store, 'ensureLane').mockImplementation((input) => {
    const lane = ensure(input)
    controller.abort()
    return lane
  })
  const admissionFailure: unknown = await admitSessions(
    store,
    state,
    sessionsRoot,
    controller.signal,
  ).catch((error: unknown) => error)
  expect(admissionFailure).toBe(controller.signal.reason)
  expect(state.added).toBe(1)
  expect(store.listLanes()).toHaveLength(1)
  vi.restoreAllMocks()
  // The admitted filename is independent of filesystem iteration order.
  const admitted = store.listLanes()[0]!
  unlinkSync(admitted.sessionFile!)
  state.known = [admitted, { ...admitted, laneId: randomUUID(), sessionFile: file }]
  const removalAbort = new AbortController()
  const markRemoved = store.markRemoved.bind(store)
  vi.spyOn(store, 'markRemoved').mockImplementation((id) => {
    markRemoved(id)
    removalAbort.abort()
  })
  const removalFailure: unknown = await removeMissingSessions(
    store,
    state,
    removalAbort.signal,
  ).catch((error: unknown) => error)
  expect(removalFailure).toBe(removalAbort.signal.reason)
  expect(state.removed).toBe(1)
  expect(store.getLane(admitted.laneId)?.removedAt).not.toBeNull()
})
