import { base64ToBytes } from '@phosphor/shared/base64'
import type { HostFrame } from '@phosphor/shared/host-protocol'
import {
  FILE_BYTES_ERRORS as ERRORS,
  FILE_BYTES_LIMITS as LIMITS,
  FILE_BYTES_METHOD,
  parseFileBytes,
  parseFileBytesParams,
} from '@phosphor/shared/host-protocol-file-bytes'

type Caller = {
  call(method: string, params: unknown): Promise<Extract<HostFrame, { type: 'result' }>>
}

export interface FileChunk {
  /** The whole file's size. */
  size: number
  version: string
  bytes: Uint8Array
}
/** Up to `length` bytes of one file from `offset`. Rejects with fixed text only. */
export type ChunkReader = (offset: number, length: number) => Promise<FileChunk>

/**
 * Chunk reads in flight per Host connection, across every download and preview. A
 * connection admits 32 calls of any kind and closes on the 33rd, and each chunk is
 * about 1.4 MB on the Host's send queue, so chunk reads never take more than this.
 */
export const READS_PER_CONNECTION = 4
const gates = new WeakMap<Caller, { active: number; waiting: (() => void)[] }>()

async function gated<T>(c: Caller, run: () => Promise<T>): Promise<T> {
  let gate = gates.get(c)
  if (!gate) gates.set(c, (gate = { active: 0, waiting: [] }))
  if (gate.active < READS_PER_CONNECTION) gate.active++
  else await new Promise<void>((resolve) => gate.waiting.push(resolve))
  try {
    return await run()
  } finally {
    // Hand the slot straight to the next read, or give it back.
    const next = gate.waiting.shift()
    if (next) next()
    else gate.active--
  }
}

/** One file of a Host lane, by its lane-relative path, a chunk per `files.readBytes`. */
export function laneFileReader(c: Caller, laneId: string, path: string): ChunkReader {
  return async (offset, length) => {
    const params = parseFileBytesParams({ laneId, path, offset, length })
    const result =
      params && (await gated(c, () => c.call(FILE_BYTES_METHOD, params)).catch(() => null))
    if (!params || !result) throw new Error(ERRORS.failed)
    if (!result.ok)
      throw new Error(
        result.error.code === 'too-large'
          ? ERRORS.tooLarge
          : result.error.code === 'unsupported'
            ? ERRORS.outdated
            : ERRORS.failed,
      )
    const chunk = parseFileBytes(result.data, params)
    if (!chunk) throw new Error(ERRORS.failed)
    return { size: chunk.size, version: chunk.version, bytes: base64ToBytes(chunk.data) }
  }
}

export interface TransferOptions {
  signal?: AbortSignal
  onProgress?: (received: number, size: number) => void
  /** Chunks in flight at once; each is about 1.4 MB on the wire. */
  parallel?: number
}

/**
 * Copy a whole file from `read` into `write`, which receives each chunk with its
 * offset, possibly out of order. Every chunk must carry the first one's version,
 * or the copy would be torn. Resolves to the file's size; rejects with fixed text,
 * only once no chunk is in flight, so the caller can close what `write` writes to.
 */
export async function transferFile(
  read: ChunkReader,
  write: (bytes: Uint8Array, offset: number) => Promise<void>,
  { signal, onProgress, parallel = 4 }: TransferOptions = {},
): Promise<number> {
  const step = LIMITS.chunkBytes
  const live = () => {
    if (signal?.aborted) throw new Error(ERRORS.cancelled)
  }
  live()
  const first = await read(0, step)
  live()
  const { size, version } = first
  await write(first.bytes, 0)
  let received = first.bytes.length
  onProgress?.(received, size)
  let next = step
  let stopped = false
  async function worker(): Promise<void> {
    try {
      while (!stopped && next < size) {
        const offset = next
        next += step
        live()
        const chunk = await read(offset, step)
        live()
        if (chunk.version !== version || chunk.size !== size) throw new Error(ERRORS.changed)
        await write(chunk.bytes, offset)
        received += chunk.bytes.length
        onProgress?.(received, size)
      }
    } catch (error) {
      stopped = true
      throw error
    }
  }
  const workers = await Promise.allSettled(Array.from({ length: parallel }, worker))
  const failure = workers.find((w) => w.status === 'rejected')
  if (failure) throw failure.reason
  return size
}
