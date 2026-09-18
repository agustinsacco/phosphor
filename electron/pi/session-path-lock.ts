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

const operations = new Map<string, Promise<unknown>>()
const opening = new Map<string, Set<AbortController>>()

/** Register before queueing so deletion also cancels not-yet-started resumes. */
export async function openSessionPath<T>(
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

export function cancelSessionOpens(path: string): void {
  for (const controller of opening.get(sessionPathKey(path)) ?? []) controller.abort()
}

/** Serialize opens and deletes of one transcript, not unrelated lanes. */
export async function withSessionPath<T>(path: string, run: () => Promise<T>): Promise<T> {
  const key = sessionPathKey(path)
  const previous = operations.get(key)
  const operation = (async () => {
    await previous?.catch(() => undefined)
    return run()
  })()
  operations.set(key, operation)
  try {
    return await operation
  } finally {
    if (operations.get(key) === operation) operations.delete(key)
  }
}
