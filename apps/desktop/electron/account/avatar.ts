import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

export const AVATAR_BYTES = 256 * 1024
export const AVATAR_MS = 10_000
const CACHE_BYTES = Math.ceil(AVATAR_BYTES / 3) * 4 + 4096
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export function avatarUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' &&
      url.hostname === 'avatars.githubusercontent.com' &&
      !url.username &&
      !url.password &&
      !url.port
      ? url.href
      : null
  } catch {
    return null
  }
}

/** No credentials, redirects or renderer network access. Failure means initials. */
export async function fetchAvatar(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const safe = avatarUrl(url)
  if (!safe) return null
  try {
    const response = await fetchImpl(safe, {
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(AVATAR_MS),
    })
    try {
      const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
      if (!response.ok || !type || !TYPES.has(type)) return null
      const declared = response.headers.get('content-length')
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > AVATAR_BYTES)) return null
      if (!response.body) return null
      const reader = response.body.getReader()
      const bytes = Buffer.alloc(AVATAR_BYTES)
      let size = 0
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          if (size + next.value.length > AVATAR_BYTES) return null
          bytes.set(next.value, size)
          size += next.value.length
        }
        return size ? `data:${type};base64,${bytes.subarray(0, size).toString('base64')}` : null
      } finally {
        await reader.cancel().catch(() => undefined)
        reader.releaseLock()
      }
    } finally {
      await response.body?.cancel().catch(() => undefined)
    }
  } catch {
    return null
  }
}

function validDataUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > CACHE_BYTES) return false
  const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value)
  if (!match?.[2]) return false
  const bytes = Buffer.from(match[2], 'base64')
  return bytes.length > 0 && bytes.length <= AVATAR_BYTES && bytes.toString('base64') === match[2]
}

export function createAvatarCache(dir: string): {
  read(userId: string, source: string): string | null
  save(userId: string, source: string, dataUrl: string): void
} {
  const path = join(dir, 'avatar.json')
  return {
    read(userId, source) {
      let fd: number | undefined
      try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const stat = fstatSync(fd)
        const uid = process.getuid?.()
        if (
          !stat.isFile() ||
          (uid !== undefined && stat.uid !== uid) ||
          (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) ||
          stat.size > CACHE_BYTES
        )
          return null
        // Bound the read too: another process can grow the file after fstat.
        const bytes = Buffer.alloc(CACHE_BYTES + 1)
        let size = 0
        while (size < bytes.length) {
          const count = readSync(fd, bytes, size, bytes.length - size, null)
          if (!count) break
          size += count
        }
        if (size > CACHE_BYTES) return null
        const value: unknown = JSON.parse(bytes.subarray(0, size).toString('utf8'))
        if (
          typeof value !== 'object' ||
          value === null ||
          !('userId' in value) ||
          value.userId !== userId ||
          !('source' in value) ||
          value.source !== source ||
          !('dataUrl' in value) ||
          !validDataUrl(value.dataUrl)
        )
          return null
        return value.dataUrl
      } catch {
        return null
      } finally {
        if (fd !== undefined) closeSync(fd)
      }
    },
    save(userId, source, dataUrl) {
      if (!validDataUrl(dataUrl) || !userId || userId.length > 256 || !avatarUrl(source)) return
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      chmodSync(dir, 0o700)
      const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
      try {
        writeFileSync(temp, JSON.stringify({ userId, source, dataUrl }), {
          mode: 0o600,
          flag: 'wx',
        })
        renameSync(temp, path)
      } finally {
        rmSync(temp, { force: true })
      }
    },
  }
}
