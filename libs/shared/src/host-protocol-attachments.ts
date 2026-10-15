export const ATTACHMENT_LIMITS = {
  chunkBytes: 256 * 1024,
  fileBytes: 20 * 1024 * 1024,
  files: 10,
  hourlyBytes: 64 * 1024 * 1024,
  lifetimeMs: 60 * 60 * 1000,
} as const

export type AttachmentOp =
  | { type: 'attachments.begin'; name: string; size: number; mime: string }
  | { type: 'attachments.chunk'; uploadId: string; index: number; data: string }
  | { type: 'attachments.commit'; uploadId: string; sha256: string }

function noControls(v: string): boolean {
  return !Array.from(v).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
}

export function attachmentId(v: unknown): v is string {
  return typeof v === 'string' && /^[a-f0-9]{32}$/.test(v)
}
export function attachmentBase64(v: unknown, max = ATTACHMENT_LIMITS.chunkBytes): v is string {
  if (typeof v !== 'string' || v.length > 4 * Math.ceil(max / 3) || v.length % 4 !== 0) return false
  const padding = v.endsWith('==') ? 2 : v.endsWith('=') ? 1 : 0
  const raw = v.slice(0, v.length - padding)
  if (!/^[A-Za-z0-9+/]*$/.test(raw) || (v.length / 4) * 3 - padding > max) return false
  // Require canonical padding bits as well as the alphabet.
  const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(
    raw.at(-1) ?? 'A',
  )
  return padding === 2 ? last % 16 === 0 : padding === 1 ? last % 4 === 0 : true
}
export function parseAttachmentOp(v: unknown): AttachmentOp | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const p: Record<string, unknown> = Object.fromEntries(Object.entries(v))
  const exact = (keys: string[]) =>
    Object.keys(p).length === keys.length && keys.every((k) => Object.hasOwn(p, k))
  if (
    p.type === 'attachments.begin' &&
    exact(['type', 'name', 'size', 'mime']) &&
    typeof p.name === 'string' &&
    p.name.length > 0 &&
    p.name.length <= 200 &&
    noControls(p.name) &&
    typeof p.size === 'number' &&
    Number.isSafeInteger(p.size) &&
    p.size >= 0 &&
    p.size <= ATTACHMENT_LIMITS.fileBytes &&
    typeof p.mime === 'string' &&
    p.mime.length <= 128 &&
    /^[\w.+-]*\/?[\w.+-]*$/.test(p.mime)
  )
    return { type: p.type, name: p.name, size: p.size, mime: p.mime }
  if (
    p.type === 'attachments.chunk' &&
    exact(['type', 'uploadId', 'index', 'data']) &&
    attachmentId(p.uploadId) &&
    typeof p.index === 'number' &&
    Number.isSafeInteger(p.index) &&
    p.index >= 0 &&
    p.index < ATTACHMENT_LIMITS.fileBytes &&
    attachmentBase64(p.data) &&
    p.data.length > 0
  )
    return { type: p.type, uploadId: p.uploadId, index: p.index, data: p.data }
  if (
    p.type === 'attachments.commit' &&
    exact(['type', 'uploadId', 'sha256']) &&
    attachmentId(p.uploadId) &&
    typeof p.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(p.sha256)
  )
    return { type: p.type, uploadId: p.uploadId, sha256: p.sha256 }
  return null
}
export function parseAttachmentResult(v: unknown): { uploadId: string } | { path: string } | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v) || Object.keys(v).length !== 1)
    return null
  if ('uploadId' in v && attachmentId(v.uploadId)) return { uploadId: v.uploadId }
  if (
    'path' in v &&
    typeof v.path === 'string' &&
    v.path.startsWith('/') &&
    v.path.length <= 4096 &&
    noControls(v.path) &&
    !/[<>]/.test(v.path) &&
    v.path.split('/').every((s) => s !== '.' && s !== '..')
  )
    return { path: v.path }
  return null
}
