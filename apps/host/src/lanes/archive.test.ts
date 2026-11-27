import type { LaneSummary } from '@phosphor/shared/host-protocol'
import type { OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import { archiveHandlers } from '../ops/handlers/archives'
import { laneHandlers } from '../ops/handlers/lanes'
import type { DaemonHandlerDeps } from '../ops/handlers'
import { createWorkspaceLeases, type WorkspaceLeases } from '../owner/lease'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openStore, type HostStore } from './store'
import { HostArchives } from './archive'
import { createLaneDeletion } from './delete'

let root: string, directory: string, sessionsRoot: string, transcript: string, laneId: string
let store: HostStore, archives: HostArchives
const removed = vi.fn(),
  forget = vi.fn(),
  announce = vi.fn(),
  changed = vi.fn(),
  reap = vi.fn(),
  abort = vi.fn()
const stop = vi.fn<() => Promise<void>>()
const sessions = {
  start: vi.fn(async () => ({ sessionId: 'fresh', sessionFile: null as string | null })),
  attach: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
}
const listed = async () =>
  ((await archives.feature.call('archive.list', undefined)) as { data: { entries: unknown[] } })
    .data.entries
function service(leases?: WorkspaceLeases) {
  return new HostArchives({
    leases,
    sessions,
    directory,
    sessionsRoot,
    store,
    runtime: { mutateStoppedSession: <T>(_path: string, run: () => Promise<T>) => run() },
    stop,
    forget,
    announce,
    changed,
    terminals: { reap },
    attachments: { abort },
  })
}
beforeEach(async () => {
  vi.clearAllMocks()
  stop.mockResolvedValue(undefined)
  root = await mkdtemp(join(tmpdir(), 'host-archive-'))
  directory = join(root, 'host')
  sessionsRoot = join(root, 'sessions')
  transcript = join(sessionsRoot, 'cwd', 'saved.jsonl')
  await mkdir(join(sessionsRoot, 'cwd'), { recursive: true })
  await writeFile(transcript, 'original conversation')
  store = await openStore(directory, process.getuid?.(), { onLaneRemoved: removed })
  const repo = store.syncRepositories([root])[0]!
  laneId = store.ensureLane({
    repositoryId: repo.id,
    cwd: root,
    sessionFile: transcript,
    title: 'Keep me',
  }).laneId
  await mkdir(join(directory, 'attachments', laneId), { recursive: true })
  await writeFile(join(directory, 'attachments', laneId, 'upload'), 'attachment')
  await writeFile(join(root, '.ignored-secret'), 'keep in place')
  archives = service()
})
afterEach(async () => {
  store.close()
  await rm(root, { recursive: true, force: true })
})
it('archives without the removal hook, survives tombstone pruning, then restores original identity and attachments', async () => {
  expect(await archives.execute({ type: 'lane.archive', laneId }, () => true)).toEqual({ ok: true })
  expect(stop).toHaveBeenCalledWith(laneId, expect.any(Function))
  expect(removed).not.toHaveBeenCalled()
  expect(store.listLanes()).toEqual([])
  expect(await readFile(`${transcript}.archived`, 'utf8')).toBe('original conversation')
  expect(await readFile(join(root, '.ignored-secret'), 'utf8')).toBe('keep in place')
  expect(reap).toHaveBeenCalledOnce()
  expect(abort).toHaveBeenCalledWith(laneId)
  store.pruneRemovedLanes(Date.now() + 90 * 86400_000)
  expect(store.getLane(laneId)).not.toBeNull()
  archives = service()
  expect(
    await archives.execute({ type: 'archive.restore', archiveId: laneId }, () => true),
  ).toEqual({ ok: true })
  expect(store.listLanes()[0]?.laneId).toBe(laneId)
  expect(await readFile(transcript, 'utf8')).toBe('original conversation')
  expect(await readFile(join(directory, 'attachments', laneId, 'upload'), 'utf8')).toBe(
    'attachment',
  )
  expect(announce).toHaveBeenCalledWith(laneId)
})
it('restores a never-sent lane without retaining its nonexistent transcript path', async () => {
  await rm(transcript)
  expect(await archives.execute({ type: 'lane.archive', laneId }, () => true)).toEqual({ ok: true })
  expect(
    await archives.execute({ type: 'archive.restore', archiveId: laneId }, () => true),
  ).toEqual({ ok: true })
  expect(store.getLane(laneId)?.sessionFile).toBeNull()
  expect(store.listLanes()[0]?.laneId).toBe(laneId)
  expect(await readFile(join(directory, 'attachments', laneId, 'upload'), 'utf8')).toBe(
    'attachment',
  )
})

it('leaves everything untouched when admission is lost or stop fails', async () => {
  expect(await archives.execute({ type: 'lane.archive', laneId }, () => false)).toEqual({
    ok: false,
    code: 'forbidden',
  })
  expect(stop).not.toHaveBeenCalled()
  stop.mockRejectedValueOnce(new Error('stop failed'))
  expect(await archives.execute({ type: 'lane.archive', laneId }, () => true)).toEqual({
    ok: false,
    code: 'bad-request',
  })
  expect(await readFile(transcript, 'utf8')).toBe('original conversation')
  expect(store.listLanes()).toHaveLength(1)
  expect(removed).not.toHaveBeenCalled()
})
it('permanent cleanup removes only lane-owned files and preserves shared artifacts and the checkout by default', async () => {
  const runs = transcript.slice(0, -6)
  await mkdir(runs)
  await writeFile(join(runs, 'child.jsonl'), 'child')
  await mkdir(join(root, 'subagent-artifacts'))
  await writeFile(join(root, 'subagent-artifacts', 'shared'), 'shared')
  await archives.execute({ type: 'lane.archive', laneId }, () => true)
  expect(
    await archives.execute(
      { type: 'archive.purge', archiveId: laneId, removeWorktree: false },
      () => true,
    ),
  ).toEqual({ ok: true })
  await expect(readFile(`${transcript}.archived`)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(join(runs, 'child.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(
    readFile(join(directory, 'attachments', `${laneId}.archived`, 'upload')),
  ).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(root, '.ignored-secret'), 'utf8')).toBe('keep in place')
  expect(await readFile(join(root, 'subagent-artifacts', 'shared'), 'utf8')).toBe('shared')
  expect(removed).toHaveBeenCalledWith(laneId)
})
it('protects shared checkouts from legacy deletion after an old Host pruned archive metadata', async () => {
  const cwd = join(root, '.phosphor', 'worktrees', 'shared')
  await mkdir(cwd, { recursive: true })
  const repositoryId = store.listRepositories()[0]!.id
  const archived = store.ensureLane({ repositoryId, cwd, sessionFile: null, worktree: true })
  const sibling = store.ensureLane({ repositoryId, cwd, sessionFile: null, worktree: true })
  expect(
    await archives.execute({ type: 'lane.archive', laneId: archived.laneId }, () => true),
  ).toEqual({ ok: true })
  store.archives.forget(archived.laneId)
  store.pruneRemovedLanes(Date.now() + 90 * 86400_000)
  expect(store.getLane(archived.laneId)).toBeNull()
  stop.mockClear()
  const remove = vi.fn(async () => {})
  const deletion = createLaneDeletion({
    store,
    stop,
    remove,
    forget,
    archiveOwnsCwd: (path) => archives.ownsCwd(path),
  })
  expect(
    await deletion(
      { type: 'lane.delete', laneId: sibling.laneId, removeWorktree: true, removeBranch: true },
      () => true,
    ),
  ).toEqual({ ok: false, code: 'busy' })
  expect(stop).not.toHaveBeenCalled()
  expect(remove).not.toHaveBeenCalled()
})

it('refuses to overwrite a replacement transcript and keeps the archive recoverable', async () => {
  await archives.execute({ type: 'lane.archive', laneId }, () => true)
  await writeFile(transcript, 'replacement')
  expect(
    await archives.execute({ type: 'archive.restore', archiveId: laneId }, () => true),
  ).toEqual({ ok: false, code: 'bad-request' })
  expect(await readFile(transcript, 'utf8')).toBe('replacement')
  expect(await readFile(`${transcript}.archived`, 'utf8')).toBe('original conversation')
  expect(await archives.feature.call('archive.list', undefined)).toMatchObject({
    ok: true,
    data: { entries: [expect.objectContaining({ id: laneId, state: 'restoring' })] },
  })
})

it('restores a never-sent lane into a fresh session that binds its new file', async () => {
  await rm(transcript)
  const fresh = join(sessionsRoot, 'cwd', 'fresh.jsonl')
  sessions.start.mockRejectedValueOnce(new Error('pi failed'))
  sessions.start.mockResolvedValueOnce({ sessionId: 'fresh', sessionFile: fresh })
  expect(await archives.execute({ type: 'lane.archive', laneId }, () => true)).toEqual({ ok: true })
  const restore = { type: 'archive.restore', archiveId: laneId } as const
  expect(await archives.execute(restore, () => true)).toEqual({ ok: false, code: 'bad-request' })
  // A failed start keeps the archive listed so restore can be retried.
  expect(await listed()).toMatchObject([{ id: laneId }])
  expect(await archives.execute(restore, () => true)).toEqual({ ok: true })
  expect(sessions.start).toHaveBeenLastCalledWith({ repository: root })
  expect(sessions.attach).toHaveBeenCalledWith(laneId, 'fresh')
  expect(store.getLane(laneId)?.sessionFile).toBe(fresh)
  expect(await listed()).toEqual([])
})

it('archives and cleans up a worktree lane whose folder was removed outside Phosphor', async () => {
  const repositoryId = store.listRepositories()[0]!.id
  const gone = join(root, '.phosphor', 'worktrees', 'gone')
  const id = store.ensureLane({ repositoryId, cwd: gone, sessionFile: null, worktree: true }).laneId
  expect(await archives.execute({ type: 'lane.archive', laneId: id }, () => true)).toEqual({
    ok: true,
  })
  expect(store.listLanes().map((lane) => lane.laneId)).not.toContain(id)
  expect(
    await archives.execute(
      { type: 'archive.purge', archiveId: id, removeWorktree: true },
      () => true,
    ),
  ).toEqual({ ok: true })
  expect(await listed()).toEqual([])
})

it('a workspace lease blocks restore before moving the transcript', async () => {
  const leases = createWorkspaceLeases(() => [])
  archives = service(leases)
  expect(await archives.execute({ type: 'lane.archive', laneId }, () => true)).toEqual({ ok: true })
  await leases.take('owner', [root], 10000)
  expect(
    await archives.execute({ type: 'archive.restore', archiveId: laneId }, () => true),
  ).toEqual({ ok: false, code: 'busy' })
  expect(store.listLanes()).toEqual([])
  expect(await readFile(`${transcript}.archived`, 'utf8')).toBe('original conversation')
})

function agentArchive() {
  const summary = (id: string): LaneSummary | null => {
    const row = store.getLane(id)
    return row?.removedAt === null
      ? { ...row, activity: 'stopped', control: { fence: 0, controller: null } }
      : null
  }
  const deps = {
    store,
    selfIds: () => ['local'],
    daemonLanes: { summary, sessionFor: () => null },
    management: { archives },
  } as unknown as DaemonHandlerDeps
  const context: OpHandlerContext = {
    principal: {
      kind: 'agent',
      laneRef: 'issuer',
      sessionId: 'issuer',
      unattended: false,
      lineage: 0,
    },
    lane: {
      ref: `host:local/lane:${laneId}`,
      cwd: root,
      title: 'Keep me',
      sessionId: null,
      busy: false,
      controller: null,
    },
    signal: new AbortController().signal,
    log: () => {},
  }
  const lane = laneHandlers(deps)
  const archive = archiveHandlers(deps)
  return {
    'lane.archive': () => lane['lane.archive']!({ ref: laneId }, context),
    'archive.restore': () => archive['archive.restore']!({ id: laneId }, context),
    'archive.purge': () => archive['archive.purge']!({ ids: [laneId] }, context),
  }
}

it.each(['agent', 'ui'] as const)(
  'invalidates open archive inventories after %s mutations',
  async (mode) => {
    // Warm the inventory before the write; notification must come after cache invalidation.
    expect(await listed()).toEqual([])
    const observed: Promise<unknown[]>[] = []
    changed.mockImplementation(() => observed.push(listed()))
    const archive = { type: 'lane.archive', laneId } as const
    const restore = { type: 'archive.restore', archiveId: laneId } as const
    const purge = { type: 'archive.purge', archiveId: laneId, removeWorktree: false } as const
    const agent = agentArchive()
    for (const action of [archive, restore, archive, purge]) {
      if (mode === 'agent') await agent[action.type]()
      else expect(await archives.execute(action, () => true)).toEqual({ ok: true })
      await observed.at(-1)
    }
    expect(changed.mock.calls).toEqual([[laneId], [laneId], [laneId], [laneId]])
    expect(await Promise.all(observed)).toEqual([
      [expect.objectContaining({ id: laneId })],
      [],
      [expect.objectContaining({ id: laneId })],
      [],
    ])
    expect(forget).toHaveBeenCalledTimes(3)
  },
)
