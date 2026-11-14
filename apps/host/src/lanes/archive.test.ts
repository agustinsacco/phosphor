import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openStore, type HostStore } from './store'
import { HostArchives } from './archive'

let root: string, directory: string, sessionsRoot: string, transcript: string, laneId: string
let store: HostStore, archives: HostArchives
const removed = vi.fn(),
  forget = vi.fn(),
  announce = vi.fn(),
  reap = vi.fn(),
  abort = vi.fn()
const stop = vi.fn<() => Promise<void>>()
function service() {
  return new HostArchives({
    directory,
    sessionsRoot,
    store,
    runtime: { mutateStoppedSession: <T>(_path: string, run: () => Promise<T>) => run() },
    stop,
    forget,
    announce,
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
