import { create } from 'zustand'
import type { ComposerDraftRecord, DraftAttachment } from '@shared/models'
import type { PendingAttachment } from '@/features/chat/attachments'

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

export function homeDraftKey(workspacePath: string): DraftKey {
  return `home:${workspacePath}`
}

export interface Draft {
  text: string
  attachments: PendingAttachment[]
  model?: { provider: string; id: string }
  thinking?: string
  workspacePath?: string
  preferWorktree?: boolean
}

const EMPTY: Draft = Object.freeze({ text: '', attachments: [] })

interface DraftsState {
  /** False until prefs have been read; composers must not clobber before it. */
  hydrated: boolean
  drafts: Record<DraftKey, Draft>
  hydrate: () => Promise<void>
  get: (key: DraftKey) => Draft
  setText: (key: DraftKey, text: string) => void
  setAttachments: (key: DraftKey, attachments: PendingAttachment[]) => void
  patch: (key: DraftKey, patch: Partial<Draft>) => void
  clear: (key: DraftKey) => void
  /** Move a draft when a session learns its file path (see `sessionDraftKey`). */
  rekey: (from: DraftKey, to: DraftKey) => void
}

export const useDraftsStore = create<DraftsState>((set, get) => ({
  hydrated: false,
  drafts: {},

  hydrate: async () => {
    if (get().hydrated) return
    // The sweep is the launch-time GC: it drops drafts whose workspace is gone
    // and unlinks orphan blobs, then hands back what survived.
    const records = await window.phosphor.invoke('app:sweepDrafts')
    const entries = await Promise.all(
      Object.entries(records).map(async ([key, record]) => [key, await toDraft(record)] as const),
    )
    // Anything typed while hydrate was in flight wins — losing a keystroke to
    // a slow disk read is exactly the bug this store exists to stop.
    set((s) => ({ hydrated: true, drafts: { ...Object.fromEntries(entries), ...s.drafts } }))
  },

  get: (key) => get().drafts[key] ?? EMPTY,

  setText: (key, text) => get().patch(key, { text }),

  setAttachments: (key, attachments) => get().patch(key, { attachments }),

  patch: (key, patch) => {
    const next = { ...(get().drafts[key] ?? EMPTY), ...patch }
    set((s) => ({ drafts: { ...s.drafts, [key]: next } }))
    schedulePersist(key, next)
  },

  clear: (key) => {
    cancelPersist(key)
    set((s) => {
      const drafts = { ...s.drafts }
      delete drafts[key]
      return { drafts }
    })
    void window.phosphor.invoke('app:clearDraft', key)
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
    void window.phosphor.invoke('app:clearDraft', from)
    schedulePersist(to, draft)
  },
}))

/** Empty means "nothing worth keeping" — do not persist a blank record. */
export function isEmptyDraft(draft: Draft): boolean {
  return draft.text.trim() === '' && draft.attachments.length === 0
}

// ---------- persistence ----------

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
      void persist(key, draft)
    }, PERSIST_DEBOUNCE_MS),
  )
}

async function persist(key: DraftKey, draft: Draft): Promise<void> {
  if (isEmptyDraft(draft)) {
    await window.phosphor.invoke('app:clearDraft', key)
    return
  }
  const saved = await Promise.all(draft.attachments.map((a) => saveAttachment(a)))
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
  await window.phosphor.invoke('app:setDraft', {
    key,
    text: draft.text,
    attachments: saved.map((entry) => entry.record).filter((a): a is DraftAttachment => a !== null),
    ...(draft.model ? { model: draft.model } : {}),
    ...(draft.thinking ? { thinking: draft.thinking } : {}),
    ...(draft.workspacePath ? { workspacePath: draft.workspacePath } : {}),
    ...(draft.preferWorktree !== undefined ? { preferWorktree: draft.preferWorktree } : {}),
    updatedAt: Date.now(),
  })
}

/**
 * Write an image's bytes if they are not on disk yet.
 *
 * `attachment` comes back non-null when it gained a blobId and the caller
 * should keep the new object; `record` is what goes into prefs, and is null
 * when the write was refused for the size cap — the chip stays in memory, it
 * just will not survive a restart.
 */
async function saveAttachment(
  attachment: PendingAttachment,
): Promise<{ record: DraftAttachment | null; attachment: PendingAttachment | null }> {
  if (attachment.kind === 'file') {
    return {
      record: { kind: 'file', name: attachment.name, size: attachment.size, path: attachment.path },
      attachment: null,
    }
  }
  let blobId = attachment.blobId
  let updated: PendingAttachment | null = null
  if (!blobId) {
    blobId = newBlobId()
    const ok = await window.phosphor.invoke('app:writeDraftBlob', blobId, attachment.data)
    if (!ok) return { record: null, attachment: null }
    updated = { ...attachment, blobId }
  }
  return {
    record: {
      kind: 'image',
      name: attachment.name,
      size: attachment.data.length,
      blobId,
      mimeType: attachment.mimeType,
    },
    attachment: updated,
  }
}

async function toDraft(record: ComposerDraftRecord): Promise<Draft> {
  const attachments = await Promise.all(
    record.attachments.map(async (a): Promise<PendingAttachment | null> => {
      if (a.kind === 'file') {
        return a.path ? { kind: 'file', path: a.path, name: a.name, size: a.size } : null
      }
      if (!a.blobId) return null
      const data = await window.phosphor.invoke('app:readDraftBlob', a.blobId)
      // The file is gone: drop the chip rather than showing a broken image.
      if (data === null) return null
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
    ...(record.workspacePath ? { workspacePath: record.workspacePath } : {}),
    ...(record.preferWorktree !== undefined ? { preferWorktree: record.preferWorktree } : {}),
  }
}

/** crypto.randomUUID is available in the renderer under the strict CSP. */
function newBlobId(): string {
  return crypto.randomUUID()
}
