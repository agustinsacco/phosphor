/**
 * Chunk size for `String.fromCharCode(...)` spreads. Passing a whole multi-MB
 * image as one argument list overflows the call stack, so bytes are encoded in
 * 32 KiB batches.
 */
const CHUNK_SIZE = 0x8000

/** Encode raw bytes as base64 without blowing the stack on large inputs. */
export function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE))
  }
  return btoa(binary)
}
