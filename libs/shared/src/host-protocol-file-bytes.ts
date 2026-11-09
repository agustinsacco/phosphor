import { attachmentBase64 } from './host-protocol-attachments'
import { parseFileParams } from './host-protocol-files'

/**
 * `files.readBytes`: one chunk of a file's raw bytes, so a client can download
 * or stream a file `files.read` (text up to 2 MiB) cannot carry. Each call is
 * independent; `version` changes when the file does, so a client reading many
 * chunks can tell its copy would be torn.
 */
export const FILE_BYTES_METHOD = 'files.readBytes'
export const FILE_BYTES_LIMITS = {
  /** The largest file a Host serves as bytes. */
  fileBytes: 1024 * 1024 * 1024,
  /** Decoded bytes per call; base64 keeps a chunk well inside the outbound frame. */
  chunkBytes: 1024 * 1024,
} as const

export interface FileBytesParams {
  laneId?: string
  repositoryId?: string
  path: string
  offset: number
  length: number
}
export interface FileBytes {
  /** The whole file's size, not the chunk's. */
  size: number
  /** Opaque: the same while the file is unchanged. */
  version: string
  /** base64 of `min(length, size - offset)` bytes from `offset`. */
  data: string
}

const count = (v: unknown, max: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max

export function parseFileBytesParams(v: unknown): FileBytesParams | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const { offset, length, ...target } = v as Record<string, unknown>
  if (!count(offset, FILE_BYTES_LIMITS.fileBytes) || !count(length, FILE_BYTES_LIMITS.chunkBytes))
    return null
  const p = parseFileParams('files.read', target)
  return p?.path === undefined ? null : { ...p, path: p.path, offset, length }
}

/** base64's decoded length, for a string `attachmentBase64` accepted. */
function decodedLength(data: string): number {
  return (data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
}

/** A chunk that answers exactly `request`: the bytes it asked for, or the file's end. */
export function parseFileBytes(
  v: unknown,
  request: Pick<FileBytesParams, 'offset' | 'length'>,
): FileBytes | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const r = v as Record<string, unknown>
  if (
    Object.keys(r).length !== 3 ||
    !count(r.size, FILE_BYTES_LIMITS.fileBytes) ||
    typeof r.version !== 'string' ||
    !/^[a-f0-9]{32}$/.test(r.version) ||
    !attachmentBase64(r.data, FILE_BYTES_LIMITS.chunkBytes) ||
    request.offset > r.size
  )
    return null
  const expected = Math.min(request.length, r.size - request.offset)
  return decodedLength(r.data) === expected
    ? { size: r.size, version: r.version, data: r.data }
    : null
}

/** Fixed text for a transfer that did not finish; a Host's own words never reach the UI. */
export const FILE_BYTES_ERRORS = {
  tooLarge: 'Larger than 1 GB: too big to bring over from its Host.',
  changed: 'The file changed on its Host during the download. Try again.',
  outdated: 'Update this machine’s Host to download its files.',
  failed: 'Could not download this file.',
  cancelled: 'Download cancelled.',
} as const
