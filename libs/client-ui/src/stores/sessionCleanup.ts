/**
 * One renderer cleanup in flight per session id.
 *
 * Cleanup awaits lazy store imports before it drops the session's `live` entry.
 * A Host reconnect forgets a remote lane and reopens it under the same id, so a
 * re-adoption landed in that window, found the old entry, adopted nothing, and
 * then lost the entry to the cleanup's final drop. Adoption waits for the
 * cleanup instead, and a second cleanup of the same id joins the first.
 */
const inFlight = new Map<string, Promise<void>>()

export function trackCleanup(id: string, run: () => Promise<void>): Promise<void> {
  const running = inFlight.get(id)
  if (running) return running
  const cleanup = run().finally(() => inFlight.delete(id))
  inFlight.set(id, cleanup)
  return cleanup
}

/**
 * The cleanup still running for `id`, settled either way, or undefined when
 * none is, so an adoption with nothing to wait for still registers synchronously.
 */
export function cleanupInFlight(id: string): Promise<void> | undefined {
  return inFlight.get(id)?.then(
    () => undefined,
    () => undefined,
  )
}
