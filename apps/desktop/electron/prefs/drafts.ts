import type { ComposerDraftRecord } from '@shared/models'
import { blobIdsOf, pruneDrafts } from '../prefs-utils'
import type { PrefsGetter } from './backend'

/**
 * Store one composer draft, pruning the map back to `MAX_DRAFTS`.
 *
 * Returns the blob ids that the prune dropped, so the caller can unlink their
 * files. Without that return the images would outlive every reference to them
 * and `userData/drafts/` would only ever grow.
 */
export function setDraft(getStore: PrefsGetter, draft: ComposerDraftRecord): string[] {
  const s = getStore()
  const next = { ...(s.get('drafts') ?? {}), [draft.key]: draft }
  const { drafts, dropped } = pruneDrafts(next)
  s.set('drafts', drafts)
  return dropped
}

/** Forget one draft. Returns its blob ids so the caller can unlink them. */
export function clearDraft(getStore: PrefsGetter, key: string): string[] {
  const s = getStore()
  const drafts = { ...(s.get('drafts') ?? {}) }
  const removed = drafts[key]
  if (!removed) return []
  delete drafts[key]
  s.set('drafts', drafts)
  return blobIdsOf([removed])
}

/** Replace the whole map — used by the launch-time sweep. */
export function setDrafts(
  getStore: PrefsGetter,
  drafts: Record<string, ComposerDraftRecord>,
): void {
  getStore().set('drafts', drafts)
}
