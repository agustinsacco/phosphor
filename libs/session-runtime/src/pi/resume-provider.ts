import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { parseSessionEntries } from './session-context'

export const RESUME_PROVIDER_MAX_BYTES = 64 * 1024 * 1024

/** pi restores the last model on the selected branch, not today's global default.
 * Never write or repair the transcript, or fall back after a failed inspection. */
export async function resumeProvider(path: string): Promise<string | undefined> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size > RESUME_PROVIDER_MAX_BYTES)
      throw new Error('Cannot verify the resumed session provider.')
    const buffer = Buffer.allocUnsafe(before.size + 1)
    let total = 0
    while (total < buffer.length) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, total)
      if (!bytesRead) break
      total += bytesRead
    }
    const after = await file.stat()
    if (total !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new Error('The session changed while verifying its provider.')
    const entries = parseSessionEntries(buffer.toString('utf8', 0, total))
    if (!entries) throw new Error('Cannot verify the resumed session provider.')
    const index = new Map(
      entries.filter((entry) => entry.type !== 'session').map((entry) => [entry.id, entry]),
    )
    const seen = new Set<unknown>()
    let leaf = entries.at(-1)
    while (leaf && leaf.type !== 'session') {
      if (seen.has(leaf.id)) throw new Error('Cannot verify the resumed session provider.')
      seen.add(leaf.id)
      // Mirrors pi's getSessionContextSettings, including assistant model switches.
      if (leaf.type === 'model_change')
        return typeof leaf.provider === 'string' ? leaf.provider : undefined
      if (
        leaf.type === 'message' &&
        typeof leaf.message === 'object' &&
        leaf.message !== null &&
        'role' in leaf.message &&
        leaf.message.role === 'assistant'
      ) {
        return 'provider' in leaf.message && typeof leaf.message.provider === 'string'
          ? leaf.message.provider
          : undefined
      }
      leaf = index.get(leaf.parentId)
    }
    return undefined
  } finally {
    await file.close()
  }
}
