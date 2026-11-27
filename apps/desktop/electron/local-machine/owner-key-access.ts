import { join } from 'node:path'
import { app } from 'electron'
import { cipher } from '../account'
import { loadOwnerKey, type OwnerKeyResult } from '../daemon/owner-key'

/** One protected-storage request for setup, migration and socket reconnects. A refusal is sticky
 * until the user retries. An unanswered OS prompt is shared, never replaced by a second one. */
export function createOwnerKeyAccess(load: () => Promise<OwnerKeyResult>) {
  let request: Promise<OwnerKeyResult> | undefined
  let status: 'checking' | 'unavailable' | undefined
  let opened = false
  const listeners = new Set<() => void>()
  function set(next: typeof status) {
    status = next
    for (const listener of listeners) listener()
  }
  function get() {
    if (!request) {
      request = Promise.resolve()
        .then(load)
        .catch((): OwnerKeyResult => ({
          ok: false,
          reason: 'Protected storage could not be opened.',
        }))
        .then((result) => {
          opened ||= result.ok
          set(result.ok ? undefined : 'unavailable')
          return result
        })
      set('checking')
    }
    return request
  }
  return {
    get,
    status: () => status,
    /** Protected storage answered this run, so reading another secret from it asks nothing more. */
    opened: () => opened,
    onChange: (listener: () => void) => listeners.add(listener),
    retry() {
      if (status === 'unavailable') request = undefined
      return get()
    },
  }
}

export const ownerKeyAccess = createOwnerKeyAccess(() =>
  loadOwnerKey({ dir: join(app.getPath('userData'), 'daemon'), cipher: cipher() }),
)
