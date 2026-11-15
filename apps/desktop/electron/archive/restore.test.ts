import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ComposerDraftRecord } from '@shared/models'
import { createLaneArchiveStorage } from '@phosphor/session-runtime/lane-archive/storage'

const state = vi.hoisted(() => ({
  storage: null as ReturnType<typeof createLaneArchiveStorage> | null,
  get: vi.fn(),
  drafts: {} as Record<string, ComposerDraftRecord>,
}))
vi.mock('../registry', () => ({ registry: { get: state.get, list: () => [] } }))
vi.mock('../store', () => ({
  getPrefs: () => ({ drafts: state.drafts }),
  setDrafts: (drafts: Record<string, ComposerDraftRecord>) => { state.drafts = drafts },
  clearDraft: vi.fn(),
}))
vi.mock('../drafts-blobs', () => ({ deleteDraftBlobs: vi.fn() }))
vi.mock('../pi/delete-lane', () => ({ createLaneRemoval: vi.fn() }))
vi.mock('../pi/session-deleter', () => ({ deleteSession: vi.fn() }))
vi.mock('../pi/session-scanner', () => ({ listSessions: vi.fn(), parseSessionFile: vi.fn() }))
vi.mock('../pi/session-watcher', () => ({ notifyWorkspaceSessions: vi.fn(), unwatchWorkspaceSessions: vi.fn() }))
vi.mock('../fs/git-worktrees', () => ({ removeWorktree: vi.fn() }))
vi.mock('../maintenance/history', () => ({ withWorkspace: <T>(_cwd: string, run: () => Promise<T>) => run() }))
vi.mock('../pi/session-path-lock', () => ({ sessionPaths: {
  cancelSessionOpens: vi.fn(), withSessionPath: <T>(_key: string, run: () => Promise<T>) => run(),
} }))
vi.mock('./state', () => ({
  localArchives: () => ({ storage: state.storage!, inventory: { invalidate: vi.fn() } }),
  assertNoArchivedOwners: vi.fn(),
}))
import { restoreLocalArchive } from './operations'

let root: string, cwd: string
const id = 'a'.repeat(64)
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archive-restore-'))
  cwd = join(root, 'checkout')
  await mkdir(cwd)
  await mkdir(join(root, 'sessions'))
  state.storage = createLaneArchiveStorage(join(root, 'archives'), join(root, 'sessions'))
  state.get.mockReset()
  state.drafts = { 'session:old': { key: 'session:old', text: 'Unsent work', attachments: [], updatedAt: 1 } }
  await state.storage.prepare({ id, cwd, title: 'Empty lane', metadata: { draftKey: 'session:old' } })
  await state.storage.archive(id)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
it('keeps an empty restore retryable until a replacement session actually exists', async () => {
  await restoreLocalArchive(id)
  await expect(state.storage!.get(id)).resolves.toMatchObject({ state: 'restoring' })
  expect(await restoreLocalArchive(id)).toMatchObject({ cwd, draftKey: 'session:old' })
  expect(state.drafts['session:old']?.text).toBe('Unsent work')
})
it('refuses completion with a missing session or a session belonging to another checkout', async () => {
  await restoreLocalArchive(id)
  await expect(restoreLocalArchive(id, 'missing')).rejects.toThrow()
  state.get.mockReturnValue({ workspacePath: join(root, 'other'), client: {} })
  await expect(restoreLocalArchive(id, 'wrong')).rejects.toThrow()
  await expect(state.storage!.get(id)).resolves.toMatchObject({ state: 'restoring' })
})
it('moves the persisted draft before completing an empty restore', async () => {
  await restoreLocalArchive(id)
  state.get.mockReturnValue({ workspacePath: cwd, client: {} })
  expect(await restoreLocalArchive(id, 'replacement')).toMatchObject({ cwd, draftKey: 'session:old', restoredDraftKey: 'session:replacement' })
  expect(state.drafts['session:replacement']?.text).toBe('Unsent work')
  expect(state.drafts['session:old']).toBeUndefined()
  await expect(state.storage!.get(id)).rejects.toMatchObject({ code: 'ENOENT' })
})
