import { resolve } from 'node:path'
import { realpathSync } from 'node:fs'

/** One spelling for an existing transcript, also usable after it is trashed. */
export function sessionPathKey(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

/**
 * Runs work per key in submission order, inside this process only. Work on one key
 * waits for the earlier work to settle, whether it succeeded or failed; different
 * keys never wait for each other. The one home for a promise-chain lock.
 */
export function createKeyedLock() {
  const tails = new Map<string, Promise<unknown>>()
  return {
    /** Whether `run(key, …)` would wait now. */
    busy: (key: string) => tails.has(key),
    async run<T>(key: string, work: () => Promise<T>): Promise<T> {
      const previous = tails.get(key)
      const current = (async () => {
        await previous?.catch(() => undefined)
        return work()
      })()
      tails.set(key, current)
      try {
        return await current
      } finally {
        if (tails.get(key) === current) tails.delete(key)
      }
    },
  }
}

/** One lock domain per process owner, shared by every create and delete entry point. */
export function createSessionPathRuntime() {
  const operations = createKeyedLock()
  const opening = new Map<string, Set<AbortController>>()

  /** Register before queueing so deletion also cancels not-yet-started resumes. */
  async function openSessionPath<T>(
    path: string,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const key = sessionPathKey(path)
    const controller = new AbortController()
    const controllers = opening.get(key) ?? new Set<AbortController>()
    controllers.add(controller)
    opening.set(key, controllers)
    try {
      return await withSessionPath(key, () => {
        controller.signal.throwIfAborted()
        return run(controller.signal)
      })
    } finally {
      controllers.delete(controller)
      if (controllers.size === 0) opening.delete(key)
    }
  }

  function cancelSessionOpens(path: string): void {
    for (const controller of opening.get(sessionPathKey(path)) ?? []) controller.abort()
  }

  /** Serialize opens and deletes of one transcript, not unrelated lanes. */
  async function withSessionPath<T>(path: string, run: () => Promise<T>): Promise<T> {
    return operations.run(sessionPathKey(path), run)
  }
  return { openSessionPath, cancelSessionOpens, withSessionPath }
}
export type SessionPathRuntime = ReturnType<typeof createSessionPathRuntime>
