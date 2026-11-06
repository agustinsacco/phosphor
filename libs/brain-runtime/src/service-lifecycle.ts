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
      disposal ??= (async () => {
        closed = true
        resources.revoke()
        resources.detach()
        resources.stopIndexing()
        resources.stopEmbeddings()
        await tail
        try {
          await resources.stopProcessor()
          await resources.purge()
        } finally {
          await resources.closeBridge()
          await resources.closeStore()
        }
      })()
      return disposal
    },
  }
}
