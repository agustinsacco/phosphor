import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HOST_LIMITS } from '@phosphor/shared/host-protocol'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import { openStore, type HostStore } from './store'
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
it('reconciles new files, preserves UUIDs across open, and marks vanished files removed', async () => {
  const file = session()
  expect(await scan()).toEqual({ repositories: 1, lanes: 1, added: 1, removed: 0 })
  const id = store.sessionLane(file)?.laneId
  store.close()
  store = await openStore(join(root, 'state'), process.getuid?.())
  expect(await scan()).toEqual({ repositories: 1, lanes: 1, added: 0, removed: 0 })
  expect(store.sessionLane(file)?.laneId).toBe(id)
  unlinkSync(file)
  expect(await scan()).toEqual({ repositories: 1, lanes: 0, added: 0, removed: 1 })
  writeFileSync(file, JSON.stringify({ type: 'session', id: randomUUID(), cwd: repository }) + '\n')
  expect((await scan()).added).toBe(1)
  expect(store.sessionLane(file)?.laneId).toBe(id)
})
it('scans known worktree cwd as well as active repositories', async () => {
  const cwd = join(root, 'worktree')
  mkdirSync(cwd)
  store.ensureLane({ repositoryId, cwd, sessionFile: null, worktree: true })
  const file = session(cwd)
  expect((await scan()).added).toBe(1)
  expect(store.sessionLane(file)?.worktree).toBe(true)
})
it('checks vanished files for live lanes whose cwd resolves through an alias', async () => {
  const cwd = join(root, 'worktree')
  mkdirSync(cwd)
  const alias = join(root, 'alias')
  symlinkSync(cwd, alias)
  const file = session(cwd)
  const lane = store.ensureLane({ repositoryId, cwd: alias, sessionFile: file, worktree: true })
  expect((await scan()).added).toBe(0)
  unlinkSync(file)
  expect((await scan()).removed).toBe(1)
  expect(store.getLane(lane.laneId)?.removedAt).not.toBeNull()
})
it('rediscovers a removed worktree lane after reopen without any live lane naming its cwd', async () => {
  const cwd = join(repository, '.phosphor', 'worktrees', 'topic')
  mkdirSync(cwd, { recursive: true })
  const file = session(cwd)
  expect((await scan()).added).toBe(1)
  const id = store.sessionLane(file)?.laneId
  unlinkSync(file)
  expect((await scan()).removed).toBe(1)
  expect(store.listLanes()).toEqual([])
  store.close()
  store = await openStore(join(root, 'state'), process.getuid?.())
  writeFileSync(file, JSON.stringify({ type: 'session', id: randomUUID(), cwd }) + '\n')
  expect((await scan()).added).toBe(1)
  expect(store.sessionLane(file)?.laneId).toBe(id)
})
it('refuses symlinked worktrees and real directories behind a parent symlink outside the repository', async () => {
  const directory = join(repository, '.phosphor', 'worktrees')
  mkdirSync(directory, { recursive: true })
  const outside = join(root, 'outside')
  mkdirSync(outside)
  session(outside)
  symlinkSync(outside, join(directory, 'linked'))
  const skipped: number[] = []
  expect((await scan((count) => skipped.push(count))).added).toBe(0)
  rmSync(join(repository, '.phosphor'), { recursive: true })
  const external = join(root, 'external')
  const cwd = join(external, 'worktrees', 'escaped')
  mkdirSync(cwd, { recursive: true })
  session(cwd)
  symlinkSync(external, join(repository, '.phosphor'))
  expect((await scan((count) => skipped.push(count))).added).toBe(0)
  expect(skipped).toEqual([1, 1])
})
it('refuses a worktree symlink even when its realpath is inside the repository', async () => {
  const target = join(repository, 'untracked')
  mkdirSync(target)
  session(target)
  const directory = join(repository, '.phosphor', 'worktrees')
  mkdirSync(directory, { recursive: true })
  symlinkSync(target, join(directory, 'linked'))
  const skipped: number[] = []
  expect((await scan((count) => skipped.push(count))).added).toBe(0)
  expect(skipped).toEqual([1])
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
it('rejects links, invalid/oversize headers, wrong cwd and non-session files without logging contents', async () => {
  const file = session()
  const directory = sessionDirForCwd(repository, join(root, 'sessions'))
  symlinkSync(file, join(directory, 'linked.jsonl'))
  session(repository, { type: 'session', id: randomUUID(), cwd: '/wrong' })
  session(repository, { type: 'session', id: 'invalid', cwd: repository })
  session(repository, {
    type: 'session',
    id: randomUUID(),
    cwd: repository,
    large: 'x'.repeat(8192),
  })
  writeFileSync(join(directory, 'missing-lf.jsonl'), '{}')
  const skipped: number[] = []
  expect((await scan((count) => skipped.push(count))).added).toBe(1)
  expect(skipped).toEqual([4])
  expect(store.listLanes()).toHaveLength(1)
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
