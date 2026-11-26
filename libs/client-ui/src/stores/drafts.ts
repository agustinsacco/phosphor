import { create } from 'zustand'
import { ipcErrorText } from '@shared/errors'
import { hostResourceKey, type HostTarget } from '@shared/remote-host'
import type { PendingAttachment } from '@/features/chat/attachments'
import { useExtensionUiStore } from './extensionUi'
import { loadDraft, saveDraft } from './draftPersistence'

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

type HeldDraft = { diskKey: DraftKey; editorKey: DraftKey; draft: Draft }
const heldDrafts = new Set<HeldDraft>()

function withoutBlobIds(attachments: PendingAttachment[]): PendingAttachment[] {
  return attachments.map((a) => (a.kind === 'image' && a.blobId ? { ...a, blobId: undefined } : a))
}

function combinedDraft(drafts: Draft[], current: Draft): Draft {
  return {
    ...current,
    text: [...drafts.map((draft) => draft.text), current.text].filter(Boolean).join('\n'),
    attachments: [...drafts.flatMap((draft) => draft.attachments), ...current.attachments],
  }
}

/** Hide the submitted draft without dropping its durable text or image references. */
export function takeSubmittedDraft(key: DraftKey) {
  const store = useDraftsStore.getState()
  const draft = store.get(key)
  const generation = memoryGeneration
  const current = () => generation === memoryGeneration
  const bytes = documentBytes(draft.attachments)
  const held: HeldDraft = { diskKey: key, editorKey: key, draft }
  heldDrafts.add(held)
  submittedFileBytes += bytes
  store.clear(key) // Clears only the editor as long as the draft is held.
  return {
    current,
    finish(accepted: boolean) {
      if (!current()) return
      heldDrafts.delete(held)
      submittedFileBytes -= bytes
      const { diskKey, editorKey } = held
      const moved = diskKey !== editorKey
      if (!accepted) {
        const restored = moved
          ? { ...held.draft, attachments: withoutBlobIds(held.draft.attachments) }
          : held.draft
        store.patch(editorKey, combinedDraft([restored], store.get(editorKey)))
        if (moved) {
          void persistNow(editorKey).then(() => (current() ? persistNow(diskKey) : undefined))
          return
        }
      }
      void persistNow(diskKey)
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

/** Hydrated records, minus any held for a submit that has no terminal receipt yet. */
function visibleDrafts(entries: readonly (readonly [DraftKey, Draft])[]): Record<DraftKey, Draft> {
  const held = new Set([...heldDrafts].map((draft) => draft.diskKey))
  return Object.fromEntries(entries.filter(([key]) => !held.has(key)))
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
        async ([key, record]) =>
          [key, await loadDraft(record, () => generation === memoryGeneration)] as const,
      ),
    )
    if (generation !== memoryGeneration) return
    // Anything typed while hydrate was in flight wins — losing a keystroke to
    // a slow disk read is exactly the bug this store exists to stop.
    set((s) => ({ hydrated: true, drafts: { ...visibleDrafts(entries), ...s.drafts } }))
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
    schedulePersist(key)
  },

  clear: (key) => {
    set((s) => {
      const drafts = { ...s.drafts }
      delete drafts[key]
      return { drafts, revisions: { ...s.revisions, [key]: (s.revisions[key] ?? 0) + 1 } }
    })
    void persistNow(key)
  },

  rekey: (from, to) => {
    if (from === to) return
    const draft = get().drafts[from]
    for (const held of heldDrafts) if (held.editorKey === from) held.editorKey = to
    if (!draft) return
    set((s) => {
      const drafts = { ...s.drafts }
      delete drafts[from]
      drafts[to] = { ...draft, attachments: withoutBlobIds(draft.attachments) }
      return { drafts }
    })
    void persistNow(from) // Held sends keep their old disk key until their receipt.
    schedulePersist(to)
  },
}))

/** Empty means "nothing worth keeping" — do not persist a blank record. */
export function isEmptyDraft(draft: Draft): boolean {
  return draft.text.trim() === '' && draft.attachments.length === 0 && !draft.swarm
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

function schedulePersist(key: DraftKey): void {
  cancelPersist(key)
  timers.set(
    key,
    setTimeout(() => void persistNow(key), PERSIST_DEBOUNCE_MS),
  )
}

const writes = new Map<DraftKey, Promise<void>>()

/** Keep a slow blob write from overwriting a later receipt or a newer editor value. */
function persistNow(key: DraftKey): Promise<void> {
  cancelPersist(key)
  const generation = memoryGeneration
  const current = () => generation === memoryGeneration
  const run = async () => {
    if (!current()) return
    const store = useDraftsStore.getState()
    const held = [...heldDrafts].filter((draft) => draft.diskKey === key)
    const editor = store.get(key)
    const draft = held.length
      ? combinedDraft(
          held.map((entry) => entry.draft),
          editor,
        )
      : editor
    const clearing = isEmptyDraft(draft)
    try {
      if (clearing) {
        await window.phosphor.invoke('app:clearDraft', key)
      } else {
        const saved = await saveDraft(key, draft, current)
        if (current() && saved.size) rememberSavedImages(key, saved)
      }
    } catch (error) {
      if (current()) {
        const action = clearing ? 'clear' : 'save'
        useExtensionUiStore
          .getState()
          .pushToast(`Could not ${action} draft: ${ipcErrorText(error)}`, 'error')
      }
    }
  }
  const previous = writes.get(key)
  const write = (previous ? previous.then(run) : run()).finally(() => {
    if (writes.get(key) === write) writes.delete(key)
  })
  writes.set(key, write)
  return write
}

function rememberSavedImages(
  key: DraftKey,
  saved: Map<PendingAttachment, PendingAttachment>,
): void {
  const remember = (draft: Draft): Draft => {
    if (!draft.attachments.some((a) => saved.has(a))) return draft
    return { ...draft, attachments: draft.attachments.map((a) => saved.get(a) ?? a) }
  }
  // A send may have moved the editor's image into a held draft during the write.
  for (const entry of heldDrafts) if (entry.diskKey === key) entry.draft = remember(entry.draft)
  useDraftsStore.setState((s) => {
    const editor = s.drafts[key]
    if (!editor) return s
    const draft = remember(editor)
    return draft === editor ? s : { drafts: { ...s.drafts, [key]: draft } }
  })
}

/** Browser sign-out clears memory and pending writes without touching native saved drafts. */
export function clearDraftMemory(): void {
  memoryGeneration++
  submittedFileBytes = 0
  heldDrafts.clear()
  writes.clear()
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  useDraftsStore.setState({ drafts: {}, revisions: {}, hydrated: false })
}
