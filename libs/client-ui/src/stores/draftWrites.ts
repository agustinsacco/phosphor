/**
 * One key's saves and clears run one at a time, and of those still waiting only the
 * newest runs: the last write wins. Overlapping, a slow image save could land after
 * newer text, or after a send's clear and bring the sent draft back.
 */
const writes = new Map<string, { tail: Promise<void>; latest: number }>()
let writeTicket = 0

export function writeDraftInOrder(key: string, write: () => Promise<void>): Promise<void> {
  const ticket = ++writeTicket
  const before = writes.get(key)?.tail
  // Nothing pending starts now, so a send's clear reaches disk at once.
  const run = before
    ? before
        .catch(() => undefined)
        .then(() => (writes.get(key)?.latest === ticket ? write() : undefined))
    : write()
  writes.set(key, { tail: run, latest: ticket })
  // The caller's promise still reports a failed write; this only forgets the key.
  void run.finally(() => writes.get(key)?.tail === run && writes.delete(key))
  return run
}
