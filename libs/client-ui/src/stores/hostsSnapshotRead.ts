/**
 * The attached remote-lanes listener's read of main's Host snapshot. That read
 * is serialized and is the only writer of the store's `hosts`, so a caller that
 * wants the snapshot again asks it instead of writing a reply of its own. A
 * detached listener's read does nothing; the latest attach wins.
 */
let listenerRead: () => Promise<void> = async () => undefined

export function bindHostsSnapshotRead(read: () => Promise<void>): void {
  listenerRead = read
}

/**
 * Reads main's Host snapshot again through the listener, coalesced with a read
 * in flight, and resolves once a read started after the call has landed.
 */
export function refreshHostsSnapshot(): Promise<void> {
  return listenerRead()
}
