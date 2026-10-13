import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { VoiceFile } from './manifest'

export interface DownloadOptions {
  signal?: AbortSignal
  /** Bytes written so far across all files, skipped ones included. */
  onProgress?: (receivedBytes: number) => void
  fetch?: typeof fetch
}

/**
 * True when every file is on disk at its pinned size. The hash is checked as
 * a file is downloaded; a file only reaches its final name after it matched.
 */
export async function filesPresent(dir: string, files: VoiceFile[]): Promise<boolean> {
  for (const file of files) {
    const info = await stat(join(dir, file.path)).catch(() => null)
    if (info?.size !== file.bytes) return false
  }
  return true
}

/**
 * Fetch every missing file into `dir`, one at a time.
 *
 * Each streams to its own `<name>.<id>.part` while it is hashed (so an
 * aborted attempt's cleanup cannot touch the next one's), and is renamed into place
 * only when both its size and its SHA-256 match the manifest. Anything else
 * (a mismatch, a network error, an abort) deletes the partial file and
 * rejects, so a half-written model never looks installed.
 */
export async function downloadFiles(
  dir: string,
  files: VoiceFile[],
  options: DownloadOptions = {},
): Promise<void> {
  const doFetch = options.fetch ?? fetch
  let received = 0
  for (const file of files) {
    const dest = join(dir, file.path)
    const existing = await stat(dest).catch(() => null)
    if (existing?.size !== file.bytes) {
      await mkdir(dirname(dest), { recursive: true })
      await fetchVerified(doFetch, file, dest, options.signal, (bytes) =>
        options.onProgress?.(received + bytes),
      )
    }
    received += file.bytes
    options.onProgress?.(received)
  }
}

async function fetchVerified(
  doFetch: typeof fetch,
  file: VoiceFile,
  dest: string,
  signal: AbortSignal | undefined,
  onBytes: (bytes: number) => void,
): Promise<void> {
  const part = `${dest}.${randomUUID().slice(0, 8)}.part`
  try {
    const response = await doFetch(file.url, { redirect: 'follow', signal })
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status} for ${file.path}`)
    }
    const hash = createHash('sha256')
    let bytes = 0
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length
        // A server that sends more than the pinned size is wrong already.
        if (bytes > file.bytes) return done(new Error(`${file.path} is larger than expected`))
        hash.update(chunk)
        onBytes(bytes)
        done(null, chunk)
      },
    })
    const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
    await pipeline(body, meter, createWriteStream(part), { signal })
    const digest = hash.digest('hex')
    if (bytes !== file.bytes || digest !== file.sha256) {
      throw new Error(`${file.path} failed verification`)
    }
    await rename(part, dest)
  } catch (error) {
    await rm(part, { force: true })
    throw error
  }
}

/**
 * Delete everything under `dir` except the given relative paths. Run after a
 * model switch (the old model goes) and on disable (`keep` is empty).
 */
export async function pruneDir(dir: string, keep: string[]): Promise<void> {
  const kept = new Set(keep.map((path) => path.split('/').join(sep)))
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    if (!kept.has(relative(dir, path))) await rm(path, { force: true })
  }
  // Model folders left empty by the loop above.
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue
    const sub = join(dir, entry.name)
    if ((await readdir(sub)).length === 0) await rm(sub, { recursive: true, force: true })
  }
}
