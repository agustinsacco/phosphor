import type { ComposerDraftRecord } from '@shared/models'
import { orphanBlobIds, sweepDrafts } from '../prefs-utils'

type Drafts = Record<string, ComposerDraftRecord>

export interface DraftServiceDeps {
  getDrafts: () => Drafts
  setDraft: (draft: ComposerDraftRecord) => string[]
  clearDraft: (key: string) => string[]
  setDrafts: (drafts: Drafts) => void
  deleteBlobs: (ids: string[]) => Promise<void>
  listBlobs: () => Promise<string[]>
  writeBlob: (id: string, base64: string) => Promise<void>
  wouldExceedBlobCap: (bytes: number) => Promise<boolean>
  pathExists: (path: string) => Promise<boolean>
}

export async function saveComposerDraft(
  deps: DraftServiceDeps,
  draft: ComposerDraftRecord,
): Promise<void> {
  // Anything the prune dropped takes its images with it.
  await deps.deleteBlobs(deps.setDraft(draft))
}

export async function clearComposerDraft(deps: DraftServiceDeps, key: string): Promise<void> {
  await deps.deleteBlobs(deps.clearDraft(key))
}

export async function writeComposerDraftBlob(
  deps: DraftServiceDeps,
  blobId: string,
  base64: string,
): Promise<boolean> {
  // Refuse rather than silently drop: the composer says so out loud.
  const bytes = Math.floor((base64.length * 3) / 4)
  if (await deps.wouldExceedBlobCap(bytes)) return false
  await deps.writeBlob(blobId, base64)
  return true
}

export async function sweepComposerDrafts(deps: DraftServiceDeps): Promise<Drafts> {
  const drafts = deps.getDrafts()
  // Resolve existence up front: `sweepDrafts` is pure so it can be tested
  // without a filesystem.
  const folders = [...new Set(Object.keys(drafts).filter((k) => k.startsWith('home:')))].map((k) =>
    k.slice('home:'.length),
  )
  const alive = new Set(
    (await Promise.all(folders.map(async (f) => ((await deps.pathExists(f)) ? f : null)))).filter(
      (f): f is string => f !== null,
    ),
  )
  const swept = sweepDrafts(drafts, (path) => alive.has(path))
  deps.setDrafts(swept.drafts)
  const orphans = orphanBlobIds(swept.drafts, await deps.listBlobs())
  await deps.deleteBlobs([...swept.dropped, ...orphans])
  return swept.drafts
}
