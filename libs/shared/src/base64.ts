/**
 * Chunk size for `String.fromCharCode(...)` spreads. Passing a whole multi-MB
 * image as one argument list overflows the call stack, so bytes are encoded in
 * 32 KiB batches.
 */
const CHUNK_SIZE = 0x8000

/** Encode raw bytes as base64 without blowing the stack on large inputs. */
export function bytesToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = ArrayBuffer.isView(buffer) ? buffer : new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE))
  }
  return btoa(binary)
}

/** Decode base64 to raw bytes; callers validate the alphabet first. */
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
