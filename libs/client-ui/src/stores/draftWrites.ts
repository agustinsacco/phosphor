/**
 * The newest save or clear of one draft wins. Every write starts at once, so newer
 * text never waits behind a slow image save and a send's clear reaches disk at once.
 * A write asks `latest()` just before its final prefs step and commits only if no
 * newer write of its key began: a stale image save that finishes late does nothing,
 * and cannot bring a sent draft back.
 */
const latestTicket = new Map<string, number>()
let writeTicket = 0

export function writeDraftInOrder(
  key: string,
  write: (latest: () => boolean) => Promise<void>,
): Promise<void> {
  const ticket = ++writeTicket
  latestTicket.set(key, ticket)
  const latest = () => latestTicket.get(key) === ticket
  const run = write(latest)
  // The caller's promise still reports a failed write; this only forgets the key.
  void run.then(
    () => latest() && latestTicket.delete(key),
    () => latest() && latestTicket.delete(key),
  )
  return run
}

/**
 * One image's blob write, shared by this draft's saves while it is in flight, so a
 * newer save that keeps the image reuses it rather than writing the bytes again.
 * Keyed by draft too: the same image in two drafts gets two blobs, or clearing one
 * draft would unlink the other's bytes.
 */
const blobWrites = new Map<string, WeakMap<object, Promise<string | null>>>()

export function writeDraftBlobOnce(
  key: string,
  attachment: object,
  write: () => Promise<string | null>,
): Promise<string | null> {
  const writes = blobWrites.get(key) ?? new WeakMap<object, Promise<string | null>>()
  blobWrites.set(key, writes)
  const pending = writes.get(attachment)
  if (pending) return pending
  const run = write().finally(() => {
    writes.delete(attachment)
  })
  writes.set(attachment, run)
  return run
}
