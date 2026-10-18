import {
  MAX_DRAFTS,
  MAX_DRAFT_BLOB_BYTES,
  type ComposerDraftRecord,
  type DraftAttachment,
} from '@phosphor/shared/models'

import { hostResourceKey } from '@phosphor/shared/remote-host'

export const BROWSER_DRAFT_LIMITS = {
  recordBytes: 256 * 1024,
  totalRecordBytes: 1024 * 1024,
  blobBytes: 8 * 1024 * 1024,
  blobs: 128,
  attachments: 16,
} as const
const blobId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9-]{8,64}$/.test(value)
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max && !value.includes('\0')
function key(value: unknown): value is string {
  if (!text(value, 8192)) return false
  if (value.length <= 4096 && /^(home|session):.+/.test(value)) return true
  try {
    const tuple: unknown = JSON.parse(value)
    if (
      !Array.isArray(tuple) ||
      tuple.length !== 4 ||
      tuple[0] !== 'remote' ||
      tuple[2] !== 'session' ||
      typeof tuple[1] !== 'string' ||
      typeof tuple[3] !== 'string'
    )
      return false
    return hostResourceKey({ kind: 'remote', hostId: tuple[1] }, 'session', tuple[3]) === value
  } catch {
    // Invalid JSON/identifiers are refused, never normalized into another draft's identity.
    return false
  }
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength

/** Owner-local scratch memory only. Keys are labels, never paths to read or create. */
export function createBrowserDrafts(signedIn: () => boolean) {
  const drafts = new Map<string, ComposerDraftRecord>()
  const blobs = new Map<string, { base64: string; bytes: number }>()
  let blobBytes = 0
  function removeBlob(id: string) {
    blobBytes -= blobs.get(id)?.bytes ?? 0
    blobs.delete(id)
  }
  function referenced() {
    return new Set(
      [...drafts.values()].flatMap((draft) =>
        draft.attachments.flatMap((a) => (a.blobId ? [a.blobId] : [])),
      ),
    )
  }
  function collect(candidates: Iterable<string>) {
    const kept = referenced()
    for (const id of candidates) if (!kept.has(id)) removeBlob(id)
  }
  function parse(raw: unknown): ComposerDraftRecord {
    if (
      !record(raw) ||
      !key(raw.key) ||
      !text(raw.text, BROWSER_DRAFT_LIMITS.recordBytes) ||
      !Array.isArray(raw.attachments) ||
      raw.attachments.length > BROWSER_DRAFT_LIMITS.attachments ||
      typeof raw.updatedAt !== 'number' ||
      !Number.isSafeInteger(raw.updatedAt) ||
      raw.updatedAt < 0
    )
      throw new Error('Invalid browser draft.')
    const attachments: DraftAttachment[] = raw.attachments.map((a) => {
      if (
        !record(a) ||
        a.kind !== 'image' ||
        !text(a.name, 256) ||
        !blobId(a.blobId) ||
        !blobs.has(a.blobId) ||
        typeof a.size !== 'number' ||
        !Number.isSafeInteger(a.size) ||
        a.size < 0 ||
        a.size > Math.ceil(BROWSER_DRAFT_LIMITS.blobBytes / 3) * 4 ||
        typeof a.mimeType !== 'string' ||
        !['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'].includes(a.mimeType)
      )
        throw new Error('Only available in-memory image attachments can be saved.')
      return { kind: 'image', name: a.name, size: a.size, blobId: a.blobId, mimeType: a.mimeType }
    })
    if (
      (raw.model !== undefined &&
        (!record(raw.model) || !text(raw.model.provider, 200) || !text(raw.model.id, 200))) ||
      (raw.thinking !== undefined && !text(raw.thinking, 100)) ||
      (raw.workspacePath !== undefined && !text(raw.workspacePath, 4096)) ||
      (raw.swarm !== undefined && typeof raw.swarm !== 'boolean') ||
      (raw.preferWorktree !== undefined && typeof raw.preferWorktree !== 'boolean')
    )
      throw new Error('Invalid browser draft metadata.')
    return {
      key: raw.key,
      text: raw.text,
      attachments,
      updatedAt: raw.updatedAt,
      ...(record(raw.model)
        ? { model: { provider: raw.model.provider as string, id: raw.model.id as string } }
        : {}),
      ...(typeof raw.thinking === 'string' ? { thinking: raw.thinking } : {}),
      ...(typeof raw.workspacePath === 'string' ? { workspacePath: raw.workspacePath } : {}),
      ...(typeof raw.swarm === 'boolean' ? { swarm: raw.swarm } : {}),
      ...(typeof raw.preferWorktree === 'boolean' ? { preferWorktree: raw.preferWorktree } : {}),
    }
  }
  const snapshot = () => structuredClone(Object.fromEntries(drafts))
  return {
    snapshot,
    set(raw: ComposerDraftRecord) {
      if (!signedIn()) throw new Error('Sign in before saving a draft.')
      const draft = parse(raw)
      if (bytes(draft) > BROWSER_DRAFT_LIMITS.recordBytes)
        throw new Error('Browser draft is too large.')
      const next = new Map(drafts)
      next.set(draft.key, draft)
      const kept = [...next.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_DRAFTS)
      if (kept.reduce((sum, row) => sum + bytes(row), 0) > BROWSER_DRAFT_LIMITS.totalRecordBytes)
        throw new Error('Browser drafts are full. Send or remove drafts first.')
      const previous = referenced()
      drafts.clear()
      for (const row of kept) drafts.set(row.key, row)
      collect(previous)
    },
    clear(key: string) {
      const previous = referenced()
      drafts.delete(key)
      collect(previous)
    },
    writeBlob(id: string, base64: string): boolean {
      if (
        !signedIn() ||
        !blobId(id) ||
        typeof base64 !== 'string' ||
        !base64.length ||
        base64.length > Math.ceil(BROWSER_DRAFT_LIMITS.blobBytes / 3) * 4 ||
        base64.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
      )
        return false
      const size =
        (base64.length / 4) * 3 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0)
      if (
        size > BROWSER_DRAFT_LIMITS.blobBytes ||
        (!blobs.has(id) && blobs.size >= BROWSER_DRAFT_LIMITS.blobs) ||
        blobBytes - (blobs.get(id)?.bytes ?? 0) + size > MAX_DRAFT_BLOB_BYTES
      )
        return false
      removeBlob(id)
      blobs.set(id, { base64, bytes: size })
      blobBytes += size
      return true
    },
    readBlob: (id: string) => blobs.get(id)?.base64 ?? null,
    sweep() {
      collect(blobs.keys())
      return snapshot()
    },
    clearOwner() {
      drafts.clear()
      blobs.clear()
      blobBytes = 0
    },
  }
}
export const OWNER_DRAFT_CHANNELS = new Set<string>([
  'app:getPrefs',
  'app:setDraft',
  'app:clearDraft',
  'app:writeDraftBlob',
  'app:readDraftBlob',
  'app:sweepDrafts',
])
