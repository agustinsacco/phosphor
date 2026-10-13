import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HOST_LIMITS } from '@phosphor/shared/host-protocol'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import { openStore, type HostStore } from './store'
import { reconcile } from './reconcile'

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
  repository = realpathSync.native(repository)
  vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', join(root, 'sessions'))
  store = await openStore(join(root, 'state'), process.getuid?.())
  const entry = store.syncRepositories([repository])[0]
  if (!entry) throw new Error('no repository')
  repositoryId = entry.id
})
afterEach(() => {
  store.close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})
function session(cwd = repository, header: unknown = { type: 'session', id: randomUUID(), cwd }) {
  const directory = sessionDirForCwd(cwd)
  mkdirSync(directory, { recursive: true })
  const file = join(directory, `${randomUUID()}.jsonl`)
  writeFileSync(
    file,
    JSON.stringify(header) + '\n' + '{invalid transcript messages are not parsed}\n',
  )
  return file
}
it('reconciles new files, preserves UUIDs across open, and marks vanished files removed', async () => {
  const file = session()
  expect(await reconcile(store)).toEqual({ repositories: 1, lanes: 1, added: 1, removed: 0 })
  const id = store.sessionLane(file)?.laneId
  store.close()
  store = await openStore(join(root, 'state'), process.getuid?.())
  expect(await reconcile(store)).toEqual({ repositories: 1, lanes: 1, added: 0, removed: 0 })
  expect(store.sessionLane(file)?.laneId).toBe(id)
  unlinkSync(file)
  expect(await reconcile(store)).toEqual({ repositories: 1, lanes: 0, added: 0, removed: 1 })
  writeFileSync(file, JSON.stringify({ type: 'session', id: randomUUID(), cwd: repository }) + '\n')
  expect((await reconcile(store)).added).toBe(1)
  expect(store.sessionLane(file)?.laneId).toBe(id)
})
it('scans known worktree cwd as well as active repositories', async () => {
  const cwd = join(root, 'worktree')
  mkdirSync(cwd)
  store.ensureLane({ repositoryId, cwd, sessionFile: null, worktree: true })
  const file = session(cwd)
  expect((await reconcile(store)).added).toBe(1)
  expect(store.sessionLane(file)?.worktree).toBe(true)
})
it('rejects links, invalid/oversize headers, wrong cwd and non-session files without logging contents', async () => {
  const file = session()
  const directory = sessionDirForCwd(repository)
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
  expect((await reconcile(store, (count) => skipped.push(count))).added).toBe(1)
  expect(skipped).toEqual([4])
  expect(store.listLanes()).toHaveLength(1)
})
it('skips unreadable or unsafe folders without treating known files as removed', async () => {
  const file = session()
  await reconcile(store)
  const directory = sessionDirForCwd(repository)
  const { renameSync } = await import('node:fs')
  renameSync(directory, directory + '-aside')
  symlinkSync(directory + '-aside', directory)
  const skipped: number[] = []
  expect(await reconcile(store, (count) => skipped.push(count))).toMatchObject({ removed: 0 })
  expect(store.sessionLane(file)?.removedAt).toBeNull()
  expect(skipped).toEqual([1])
})

it('accepts exactly 8192 header bytes and skips one byte past it', async () => {
  const header = { type: 'session', id: randomUUID(), cwd: repository, pad: '' }
  const padding = 8192 - Buffer.byteLength(JSON.stringify(header))
  session(repository, { ...header, pad: 'x'.repeat(padding) })
  session(repository, { ...header, pad: 'x'.repeat(padding + 1) })
  const skipped: number[] = []
  expect((await reconcile(store, (count) => skipped.push(count))).added).toBe(1)
  expect(skipped).toEqual([1])
})
it('bounds additions at the lane cap and bounds directory iteration', async () => {
  for (let i = 0; i < HOST_LIMITS.lanesPerHost; i++)
    store.ensureLane({ repositoryId, cwd: repository, sessionFile: null })
  const file = session()
  const skipped: number[] = []
  expect((await reconcile(store, (count) => skipped.push(count))).added).toBe(0)
  expect(store.sessionLane(file)).toBeNull()
  expect(skipped).toEqual([1])
  unlinkSync(file)
  const directory = sessionDirForCwd(repository)
  for (let i = 0; i <= HOST_LIMITS.lanesPerHost * 2; i++)
    writeFileSync(join(directory, `${i}.txt`), '')
  expect((await reconcile(store, (count) => skipped.push(count))).removed).toBe(0)
  expect(skipped).toEqual([1, 1])
})
