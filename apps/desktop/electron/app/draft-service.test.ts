import { beforeEach, expect, it, vi } from 'vitest'
import type { ComposerDraftRecord } from '@shared/models'
import {
  clearComposerDraft,
  saveComposerDraft,
  sweepComposerDrafts,
  writeComposerDraftBlob,
  type DraftServiceDeps,
} from './draft-service'

const deps = {
  getDrafts: vi.fn<DraftServiceDeps['getDrafts']>(),
  setDraft: vi.fn<DraftServiceDeps['setDraft']>(),
  clearDraft: vi.fn<DraftServiceDeps['clearDraft']>(),
  setDrafts: vi.fn<DraftServiceDeps['setDrafts']>(),
  deleteBlobs: vi.fn<DraftServiceDeps['deleteBlobs']>(),
  listBlobs: vi.fn<DraftServiceDeps['listBlobs']>(),
  writeBlob: vi.fn<DraftServiceDeps['writeBlob']>(),
  wouldExceedBlobCap: vi.fn<DraftServiceDeps['wouldExceedBlobCap']>(),
  pathExists: vi.fn<DraftServiceDeps['pathExists']>(),
}
const draft = (key: string, blobId: string): ComposerDraftRecord => ({
  key,
  text: 'draft',
  updatedAt: 1,
  attachments: [{ kind: 'image', name: 'image', size: 3, blobId }],
})
beforeEach(() => {
  vi.resetAllMocks()
  deps.getDrafts.mockReturnValue({})
  deps.listBlobs.mockResolvedValue([])
  deps.deleteBlobs.mockResolvedValue(undefined)
})

it('persists before deleting blobs pruned by save or clear', async () => {
  const value = draft('session', 'image')
  deps.setDraft.mockReturnValue(['pruned'])
  deps.clearDraft.mockReturnValue(['cleared'])
  await saveComposerDraft(deps, value)
  expect(deps.setDraft).toHaveBeenCalledWith(value)
  expect(deps.deleteBlobs).toHaveBeenCalledWith(['pruned'])
  expect(deps.setDraft.mock.invocationCallOrder[0]).toBeLessThan(
    deps.deleteBlobs.mock.invocationCallOrder[0]!,
  )
  await clearComposerDraft(deps, value.key)
  expect(deps.clearDraft).toHaveBeenCalledWith('session')
  expect(deps.deleteBlobs).toHaveBeenLastCalledWith(['cleared'])
  expect(deps.clearDraft.mock.invocationCallOrder[0]).toBeLessThan(
    deps.deleteBlobs.mock.invocationCallOrder[1]!,
  )
})

it('refuses writes above the byte cap and propagates accepted write failures', async () => {
  deps.wouldExceedBlobCap.mockResolvedValueOnce(true).mockResolvedValue(false)
  expect(await writeComposerDraftBlob(deps, 'image', 'YWJj')).toBe(false)
  expect(deps.wouldExceedBlobCap).toHaveBeenCalledWith(3)
  expect(deps.writeBlob).not.toHaveBeenCalled()
  expect(await writeComposerDraftBlob(deps, 'image', 'YWJj')).toBe(true)
  expect(deps.writeBlob).toHaveBeenCalledWith('image', 'YWJj')
  deps.writeBlob.mockRejectedValue(new Error('disk'))
  await expect(writeComposerDraftBlob(deps, 'image', 'YWJj')).rejects.toThrow('disk')
})

it('checks only home folders, keeps live session drafts and prunes dropped and orphan images in order', async () => {
  const alive = draft('home:/alive', 'kept')
  const gone = draft('home:/gone', 'dropped')
  const session = draft('session-id', 'session-image')
  deps.getDrafts.mockReturnValue({ [alive.key]: alive, [gone.key]: gone, [session.key]: session })
  deps.pathExists.mockImplementation(async (path) => path === '/alive')
  deps.listBlobs.mockResolvedValue(['kept', 'session-image', 'orphan'])
  const kept = { [alive.key]: alive, [session.key]: session }
  expect(await sweepComposerDrafts(deps)).toEqual(kept)
  expect(deps.pathExists.mock.calls).toEqual([['/alive'], ['/gone']])
  expect(deps.setDrafts).toHaveBeenCalledWith(kept)
  expect(deps.deleteBlobs).toHaveBeenCalledWith(['dropped', 'orphan'])
  expect(deps.pathExists.mock.invocationCallOrder[1]).toBeLessThan(
    deps.setDrafts.mock.invocationCallOrder[0]!,
  )
  expect(deps.setDrafts.mock.invocationCallOrder[0]).toBeLessThan(
    deps.listBlobs.mock.invocationCallOrder[0]!,
  )
  expect(deps.listBlobs.mock.invocationCallOrder[0]).toBeLessThan(
    deps.deleteBlobs.mock.invocationCallOrder[0]!,
  )
})

it('waits for blob deletion before resolving the sweep', async () => {
  let finish!: () => void
  deps.deleteBlobs.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve
    }),
  )
  let resolved = false
  const sweeping = sweepComposerDrafts(deps).then(() => {
    resolved = true
  })
  await vi.waitFor(() => expect(deps.deleteBlobs).toHaveBeenCalled())
  expect(resolved).toBe(false)
  finish()
  await sweeping
  expect(resolved).toBe(true)
})

it('does not list or delete blobs when saving swept preferences fails', async () => {
  deps.setDrafts.mockImplementation(() => {
    throw new Error('persist')
  })
  await expect(sweepComposerDrafts(deps)).rejects.toThrow('persist')
  expect(deps.listBlobs).not.toHaveBeenCalled()
  expect(deps.deleteBlobs).not.toHaveBeenCalled()
})
