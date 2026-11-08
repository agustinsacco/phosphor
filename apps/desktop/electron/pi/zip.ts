/**
 * Minimal zip read/write for skill bundles — no dependency on purpose.
 *
 * Reading is the security boundary for both skill installs (GitHub zipballs)
 * and user uploads, so the guards live here, in one place, and are not
 * optional parameters a caller can forget: entry names are rejected on
 * traversal (`..`), absolute paths and backslashes; symlink entries are
 * rejected outright (a symlink extracted into a skills dir points the next
 * read anywhere on disk); and entry/byte caps bound a zip bomb before any
 * inflate output is retained.
 *
 * Writing is the shared STORE writer (`@phosphor/shared/zip-store`).
 */
import { inflateRawSync } from 'node:zlib'
import { writeZipStore as writeZipBytes } from '@phosphor/shared/zip-store'

export interface ZipEntry {
  /** Normalized forward-slash relative path. Directories end with `/`. */
  path: string
  data: Buffer
}

export const ZIP_MAX_ENTRIES = 2000
export const ZIP_MAX_TOTAL_BYTES = 50 * 1024 * 1024
export const ZIP_MAX_FILE_BYTES = 20 * 1024 * 1024

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
/** Unix file-type bits live in the high 16 of external attributes. */
const S_IFMT = 0xf000
const S_IFLNK = 0xa000

/** Reject an entry name that could escape the extraction root. */
export function invalidZipEntryName(name: string): string | null {
  if (!name) return 'empty entry name'
  if (name.includes('\\')) return 'backslash in entry name'
  if (name.startsWith('/')) return 'absolute entry name'
  if (name.split('/').some((part) => part === '..')) return 'path traversal in entry name'
  if (name.includes('\0')) return 'NUL in entry name'
  return null
}

/**
 * Parse a zip buffer into file entries (directories are dropped — extraction
 * creates parents as needed). Throws on anything the guards refuse; a zip we
 * cannot fully trust is a zip we do not partially extract.
 */
export function readZipEntries(zip: Buffer): ZipEntry[] {
  const eocd = findEocd(zip)
  const count = zip.readUInt16LE(eocd + 10)
  if (count > ZIP_MAX_ENTRIES) throw new Error(`zip has ${count} entries (max ${ZIP_MAX_ENTRIES})`)
  let offset = zip.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []
  let total = 0
  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(offset) !== CENTRAL_SIG) throw new Error('malformed central directory')
    const method = zip.readUInt16LE(offset + 10)
    const compressedSize = zip.readUInt32LE(offset + 20)
    const uncompressedSize = zip.readUInt32LE(offset + 24)
    const nameLength = zip.readUInt16LE(offset + 28)
    const extraLength = zip.readUInt16LE(offset + 30)
    const commentLength = zip.readUInt16LE(offset + 32)
    const externalAttrs = zip.readUInt32LE(offset + 38)
    const localOffset = zip.readUInt32LE(offset + 42)
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    offset += 46 + nameLength + extraLength + commentLength

    const nameError = invalidZipEntryName(name)
    if (nameError) throw new Error(`${nameError}: ${name}`)
    if (((externalAttrs >>> 16) & S_IFMT) === S_IFLNK)
      throw new Error(`symlink entry refused: ${name}`)
    if (name.endsWith('/')) continue
    if (uncompressedSize > ZIP_MAX_FILE_BYTES) throw new Error(`entry too large: ${name}`)
    total += uncompressedSize
    if (total > ZIP_MAX_TOTAL_BYTES) throw new Error('zip exceeds total size cap')

    if (zip.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error('malformed local header')
    const localNameLength = zip.readUInt16LE(localOffset + 26)
    const localExtraLength = zip.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = zip.subarray(dataStart, dataStart + compressedSize)
    let data: Buffer
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: ZIP_MAX_FILE_BYTES })
    else throw new Error(`unsupported compression method ${method}: ${name}`)
    if (data.length !== uncompressedSize) throw new Error(`size mismatch: ${name}`)
    entries.push({ path: name, data })
  }
  return entries
}

function findEocd(zip: Buffer): number {
  const floor = Math.max(0, zip.length - 22 - 65535)
  for (let index = zip.length - 22; index >= floor; index -= 1) {
    if (zip.readUInt32LE(index) === EOCD_SIG) return index
  }
  throw new Error('not a zip file (no end-of-central-directory)')
}

/**
 * The shared STORE writer as a Buffer, the type `readZipEntries` and Desktop's callers take.
 * `skills.install.characterization.test.ts` (frozen) imports it from here.
 */
export function writeZipStore(entries: ZipEntry[]): Buffer {
  const zip = writeZipBytes(entries)
  return Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength)
}
