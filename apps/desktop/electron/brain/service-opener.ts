/** A cached or in-flight service never bypasses the launch and durable ownership checks. */
export function createDesktopBrainOpener<T>(admit: () => void, construct: () => Promise<T>) {
  let pending: Promise<T> | undefined
  let closing = false
  const check = () => {
    if (closing) throw new Error('Brain is shutting down')
    admit()
  }
  return {
    async get(): Promise<T> {
      check()
      pending ??= construct().catch((error: unknown) => {
        pending = undefined
        throw error
      })
      const service = await pending
      check()
      return service
    },
    close() {
      closing = true
      return pending
    },
  }
}
