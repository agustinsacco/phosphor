import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

/**
 * Bytes read per chunk while hashing a downloaded update archive. A release
 * zip is ~170MB; reading it in chunks keeps memory flat instead of holding the
 * whole archive in one Buffer.
 */
export const ARCHIVE_HASH_CHUNK_BYTES = 1024 * 1024

/**
 * Base64 sha512 of a file, the encoding `latest-mac.yml` publishes.
 *
 * Rejects with the read stream's own error, and the stream is closed when the
 * promise settles either way.
 */
export async function sha512Base64(path: string): Promise<string> {
  const hash = createHash('sha512')
  const stream = createReadStream(path, { highWaterMark: ARCHIVE_HASH_CHUNK_BYTES })
  for await (const chunk of stream) hash.update(chunk as Buffer)
  return hash.digest('base64')
}
