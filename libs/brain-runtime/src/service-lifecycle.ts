interface LifecycleResources {
  revoke(): void
  detach(): void
  stopEmbeddings(): void
  stopIndexing(): void
  stopProcessor(): Promise<void>
  purge(): Promise<void>
  closeBridge(): Promise<void>
  closeStore(): Promise<void>
}
export function createBrainLifecycle(resources: LifecycleResources) {
  let tail = Promise.resolve()
  let closed = false
  let disposal: Promise<void> | undefined
  return {
    isClosed: () => closed,
    serialize<T>(operation: () => Promise<T>): Promise<T> {
      if (closed) return Promise.reject(new Error('Brain is disposed'))
      const result = tail.then(operation)
      tail = result.then(
        () => {},
        () => {},
      )
      return result
    },
    dispose() {
      if (!closed) {
        closed = true
        resources.revoke()
        resources.detach()
        resources.stopIndexing()
        resources.stopEmbeddings()
      }
      disposal ??= (async () => {
        await tail
        await resources.stopProcessor()
        await resources.purge()
        await resources.closeBridge()
        await resources.closeStore()
      })().catch((error: unknown) => {
        // Keep cleanup ports available. Revocation stays fenced while an owner is retained.
        disposal = undefined
        throw error
      })
      return disposal
    },
  }
}
