import { create } from 'zustand'
import { ipcErrorText } from '@shared/errors'
import type { ComposerDraftRecord, DraftAttachment } from '@shared/models'
import { hostResourceKey, type HostTarget } from '@shared/remote-host'
import type { PendingAttachment } from '@/features/chat/attachments'
import { reclaimDraftUploads, saveDraftAttachment, writeDraftInOrder } from './draftWrites'
import { useExtensionUiStore } from './extensionUi'

/**
 * Unsent composer state, durable across session switches AND restarts.
 *
 * Both composers kept their text and pending attachments in local `useState`,
 * and `App` renders `<ChatView key={activeSessionId}>` — so switching session
 * unmounted the composer and threw the draft away silently. Quitting did the
 * same. Lifting the value here fixes both with one mechanism, and lets the
 * `key` stay (it is what keeps per-session transcript state honest).
 *
 * Image bytes do not live in this store's persisted slice: they are written to
 * `userData/drafts/` by blob id (`electron/drafts-blobs.ts`) and read back on
 * hydrate. The base64 is only ever in memory for the drafts you have opened.
 */

/** `session:<sessionFilePath | phosphorId>` or `home:<workspacePath>`. */
export type DraftKey = string

export function sessionDraftKey(sessionFilePath: string | undefined, phosphorId: string): DraftKey {
  // Prefer the file path: it is the only identity that survives a restart.
  // `phosphorId` covers the window before pi has told us where the file is.
  return `session:${sessionFilePath ?? phosphorId}`
}

/** The key a lane's composer files its draft under; Host lanes key by lane id. */
export function composerDraftKey(
  entry: { diskPath?: string; target?: HostTarget; laneId?: string } | undefined,
  phosphorId: string,
): DraftKey {
  return entry?.target?.kind === 'remote' && entry.laneId
    ? hostResourceKey(entry.target, 'session', entry.laneId)
    : sessionDraftKey(entry?.diskPath, phosphorId)
}

export function homeDraftKey(workspacePath: string): DraftKey {
  return `home:${workspacePath}`
}

export interface Draft {
  text: string
  attachments: PendingAttachment[]
  model?: { provider: string; id: string }
  thinking?: string
  /** Explicit authorization for this unsent new lane, never a global default. */
  swarm?: boolean
  workspacePath?: string
  preferWorktree?: boolean
}

const EMPTY: Draft = Object.freeze({ text: '', attachments: [] })
// An owner reset retires both scheduled writes and continuations already awaiting IPC.
let memoryGeneration = 0
let submittedFileBytes = 0

function documentBytes(attachments: PendingAttachment[]): number {
  let bytes = 0
  for (const a of attachments)
    if (a.kind === 'file' && a.data !== undefined)
      bytes += (a.data.length / 4) * 3 - (a.data.endsWith('==') ? 2 : a.data.endsWith('=') ? 1 : 0)
  return bytes
}

/**
 * Clear the draft now; only memory holds its recovery copy and reserved document budget.
 * `append` restores after what the destination holds, a blank line apart; by
 * default it goes first. Documents that no longer fit the cap stay out, with a warning.
 */
export function takeSubmittedDraft(
  key: DraftKey,
  restoreKey = () => key,
  { append = false }: { append?: boolean } = {},
) {
  const drafts = useDraftsStore.getState()
  const draft = drafts.get(key)
  const generation = memoryGeneration
  const current = () => generation === memoryGeneration
  const bytes = documentBytes(draft.attachments)
  submittedFileBytes += bytes
  drafts.clear(key)
  return {
    draft,
    current,
    finish(accepted: boolean) {
      if (!current()) return
      submittedFileBytes -= bytes
      if (accepted) return
      // clear() unlinks saved image blobs: persist restored images from their in-memory bytes.
      const restored = draft.attachments.map((a) =>
        a.kind === 'image' && a.blobId ? { ...a, blobId: undefined } : a,
      )
      const destination = restoreKey()
      const next = drafts.get(destination)
      const text = (append ? [next.text, draft.text] : [draft.text, next.text])
        .filter(Boolean)
        .join(append ? '\n\n' : '\n')
      const restore = (files: PendingAttachment[]) =>
        drafts.patch(destination, {
          text,
          attachments: append ? [...next.attachments, ...files] : [...files, ...next.attachments],
        })
      try {
        restore(restored)
      } catch (error) {
        restore(restored.filter((a) => a.kind !== 'file' || a.data === undefined))
        useExtensionUiStore.getState().pushToast(ipcErrorText(error), 'warning')
      }
    },
  }
}

interface DraftsState {
  /** False until prefs have been read; composers must not clobber before it. */
  hydrated: boolean
  drafts: Record<DraftKey, Draft>
  /** Semantic edits only; persistence adding blob ids is not an edit. */
  revisions: Record<DraftKey, number>
  hydrate: () => Promise<void>
  get: (key: DraftKey) => Draft
  setText: (key: DraftKey, text: string) => void
  setAttachments: (key: DraftKey, attachments: PendingAttachment[]) => void
  patch: (key: DraftKey, patch: Partial<Draft>) => void
  releaseRemoteFiles: (key: DraftKey) => void
  clear: (key: DraftKey) => void
  /** Move a draft when a session learns its file path (see `sessionDraftKey`). */
  rekey: (from: DraftKey, to: DraftKey) => void
}

export const useDraftsStore = create<DraftsState>((set, get) => ({
  hydrated: false,
  drafts: {},
  revisions: {},

  hydrate: async () => {
    if (get().hydrated) return
    const generation = memoryGeneration
    // The sweep is the launch-time GC: it drops drafts whose workspace is gone
    // and unlinks orphan blobs, then hands back what survived.
    const records = await window.phosphor.invoke('app:sweepDrafts')
    if (generation !== memoryGeneration) return
    const entries = await Promise.all(
      Object.entries(records).map(
        async ([key, record]) => [key, await toDraft(record, generation)] as const,
      ),
    )
    if (generation !== memoryGeneration) return
    // Anything typed while hydrate was in flight wins — losing a keystroke to
    // a slow disk read is exactly the bug this store exists to stop.
    set((s) => ({ hydrated: true, drafts: { ...Object.fromEntries(entries), ...s.drafts } }))
  },

  get: (key) => get().drafts[key] ?? EMPTY,

  setText: (key, text) => get().patch(key, { text }),

  setAttachments: (key, attachments) => get().patch(key, { attachments }),

  releaseRemoteFiles: (key) => {
    const draft = get().drafts[key]
    if (draft?.attachments.some((a) => a.kind === 'file' && a.data !== undefined))
      get().setAttachments(
        key,
        draft.attachments.filter((a) => a.kind !== 'file' || a.data === undefined),
      )
  },

  patch: (key, patch) => {
    if (patch.attachments) {
      let bytes = submittedFileBytes
      for (const draft of Object.values({
        ...get().drafts,
        [key]: { attachments: patch.attachments },
      }))
        bytes += documentBytes(draft.attachments)
      if (bytes > 64 * 1024 * 1024)
        throw new Error('Remote attachments are full. Send or remove files first.')
    }
    const next = { ...(get().drafts[key] ?? EMPTY), ...patch }
    set((s) => ({
      drafts: { ...s.drafts, [key]: next },
      revisions: { ...s.revisions, [key]: (s.revisions[key] ?? 0) + 1 },
    }))
    schedulePersist(key, next)
  },

  clear: (key) => {
    cancelPersist(key)
    set((s) => {
      const drafts = { ...s.drafts }
      delete drafts[key]
      return { drafts, revisions: { ...s.revisions, [key]: (s.revisions[key] ?? 0) + 1 } }
    })
    void writeDraftInOrder(key, (latest) => clearDraftOnDisk(key, latest))
  },

  rekey: (from, to) => {
    const draft = get().drafts[from]
    if (!draft || from === to) return
    cancelPersist(from)
    set((s) => {
      const drafts = { ...s.drafts }
      delete drafts[from]
      drafts[to] = draft
      return { drafts }
    })
    void writeDraftInOrder(from, (latest) => clearDraftOnDisk(from, latest))
    schedulePersist(to, draft)
  },
}))

/** Empty means "nothing worth keeping" — do not persist a blank record. */
export function isEmptyDraft(draft: Draft): boolean {
  return draft.text.trim() === '' && draft.attachments.length === 0 && !draft.swarm
}

// ---------- persistence ----------

async function clearDraftOnDisk(key: DraftKey, latest: () => boolean = () => true): Promise<void> {
  const generation = memoryGeneration
  if (!latest()) return
  try {
    await window.phosphor.invoke('app:clearDraft', key)
  } catch (error) {
    if (generation === memoryGeneration)
      useExtensionUiStore
        .getState()
        .pushToast(`Could not clear draft: ${ipcErrorText(error)}`, 'error')
  }
}

/**
 * Typing must not write to disk on every keystroke, so writes are debounced
 * per key. `clear` cancels a pending write, or a send would immediately be
 * followed by the draft it just cleared coming back.
 */
const PERSIST_DEBOUNCE_MS = 400
const timers = new Map<DraftKey, ReturnType<typeof setTimeout>>()

function cancelPersist(key: DraftKey): void {
  const timer = timers.get(key)
  if (timer) clearTimeout(timer)
  timers.delete(key)
}

function schedulePersist(key: DraftKey, draft: Draft): void {
  cancelPersist(key)
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      void writeDraftInOrder(key, (latest) => persist(key, draft, latest))
    }, PERSIST_DEBOUNCE_MS),
  )
}

async function persist(key: DraftKey, scheduled: Draft, latest: () => boolean): Promise<void> {
  const generation = memoryGeneration
  // An earlier save may have given its images blob ids since this one was scheduled.
  const draft = useDraftsStore.getState().drafts[key] ?? scheduled
  const live = () => generation === memoryGeneration
  let saved: Awaited<ReturnType<typeof saveDraftAttachment>>[] = []
  try {
    if (isEmptyDraft(draft)) {
      await clearDraftOnDisk(key, latest)
      return
    }
    const settled = await Promise.allSettled(
      draft.attachments.map((a) => saveDraftAttachment(key, a, live)),
    )
    // Every finished save is kept, so `finally` releases its hold even when another failed.
    saved = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed) throw failed.reason
    if (generation !== memoryGeneration) return
    // Remember which blob each image landed in, so re-saving the same draft is
    // one write rather than one per keystroke. Kept ON THE ATTACHMENT rather
    // than in a module-level map keyed by object identity: the same image can
    // sit in two drafts, and sharing one blob between them means clearing
    // either draft unlinks the other's bytes.
    const withIds = saved.map((entry, i) => entry.attachment ?? draft.attachments[i]!)
    useDraftsStore.setState((s) => {
      const current = s.drafts[key]
      // The user edited while we were writing; their array wins.
      if (!current || current.attachments !== draft.attachments) return s
      return { drafts: { ...s.drafts, [key]: { ...current, attachments: withIds } } }
    })
    // A newer save or clear of this draft began: it alone reaches prefs.
    if (generation !== memoryGeneration) return
    if (!latest())
      return reclaimDraftUploads(
        saved.map((entry) => entry.upload),
        blobReferenced,
      )
    await window.phosphor.invoke('app:setDraft', {
      key,
      text: draft.text,
      attachments: saved
        .map((entry) => entry.record)
        .filter((a): a is DraftAttachment => a !== null),
      ...(draft.model ? { model: draft.model } : {}),
      ...(draft.thinking ? { thinking: draft.thinking } : {}),
      ...(draft.swarm !== undefined ? { swarm: draft.swarm } : {}),
      ...(draft.workspacePath ? { workspacePath: draft.workspacePath } : {}),
      ...(draft.preferWorktree !== undefined ? { preferWorktree: draft.preferWorktree } : {}),
      updatedAt: Date.now(),
    })
  } catch (error) {
    if (generation === memoryGeneration) throw error
  } finally {
    for (const entry of saved) entry.upload?.release()
  }
}

const blobReferenced = (blobId: string): boolean =>
  Object.values(useDraftsStore.getState().drafts).some((d) =>
    d.attachments.some((a) => a.kind === 'image' && a.blobId === blobId),
  )

async function toDraft(record: ComposerDraftRecord, generation: number): Promise<Draft> {
  const attachments = await Promise.all(
    record.attachments.map(async (a): Promise<PendingAttachment | null> => {
      if (generation !== memoryGeneration) return null
      if (a.kind === 'file') {
        return a.path ? { kind: 'file', path: a.path, name: a.name, size: a.size } : null
      }
      if (!a.blobId) return null
      const data = await window.phosphor.invoke('app:readDraftBlob', a.blobId)
      // The file is gone: drop the chip rather than showing a broken image.
      if (generation !== memoryGeneration || data === null) return null
      // Carrying the blobId back means re-saving this draft reuses the file
      // already on disk instead of writing a second copy of the same bytes.
      return {
        kind: 'image',
        data,
        mimeType: a.mimeType ?? 'image/png',
        name: a.name,
        blobId: a.blobId,
      }
    }),
  )
  return {
    text: record.text,
    attachments: attachments.filter((a): a is PendingAttachment => a !== null),
    ...(record.model ? { model: record.model } : {}),
    ...(record.thinking ? { thinking: record.thinking } : {}),
    ...(record.swarm !== undefined ? { swarm: record.swarm } : {}),
    ...(record.workspacePath ? { workspacePath: record.workspacePath } : {}),
    ...(record.preferWorktree !== undefined ? { preferWorktree: record.preferWorktree } : {}),
  }
}

/** Browser sign-out clears memory and pending writes without touching native saved drafts. */
export function clearDraftMemory(): void {
  memoryGeneration++
  submittedFileBytes = 0
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  useDraftsStore.setState({ drafts: {}, revisions: {}, hydrated: false })
}
