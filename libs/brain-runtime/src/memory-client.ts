import type { MemoryOperations, MemoryRequest, MemoryResponse } from './memory-protocol'
import { MEMORY_MAX_BYTES, MEMORY_METHODS } from './memory-protocol'

export interface MemoryProcess {
  post(message: MemoryRequest): void
  onMessage(listener: (message: MemoryResponse) => void): void
  onExit(listener: () => void): void
  kill(): void
}
export type BrainMemoryClient = {
  [K in keyof MemoryOperations]: (
    ...args: Parameters<MemoryOperations[K]>
  ) => Promise<ReturnType<MemoryOperations[K]>>
}

/** One bounded request queue. A timeout poisons the connection: no unknown late writes. */
export function createMemoryClient(child: MemoryProcess, timeoutMs = 15_000): BrainMemoryClient {
  let nextId = 0
  let stopped = false
  let closing: Promise<void> | undefined
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void
      reject(error: Error): void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  const stop = (message: string): void => {
    stopped = true
    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.reject(new Error(message))
    }
    pending.clear()
    child.kill()
  }
  child.onExit(() => stop('Brain database worker exited'))
  child.onMessage((message) => {
    if (!message || !Number.isSafeInteger(message.id)) return stop('Invalid database response')
    const item = pending.get(message.id)
    if (!item) return
    pending.delete(message.id)
    clearTimeout(item.timer)
    if (Buffer.byteLength(JSON.stringify(message)) > MEMORY_MAX_BYTES) {
      item.reject(new Error('Brain database response exceeds limit'))
      stop('Invalid database response')
    } else if (message.ok) item.resolve(message.data)
    else item.reject(new Error(message.error))
  })
  const call = (method: keyof MemoryOperations, args: unknown[]): Promise<unknown> => {
    if (stopped || (closing && method !== 'close'))
      return Promise.reject(new Error('Brain database is closed'))
    if (pending.size >= 64 || Buffer.byteLength(JSON.stringify(args)) > MEMORY_MAX_BYTES)
      return Promise.reject(new Error('Brain database request exceeds limit'))
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => stop('Brain database request timed out'), timeoutMs)
      pending.set(id, { resolve, reject, timer })
      try {
        child.post({ id, method, args } as MemoryRequest)
      } catch {
        stop('Brain database worker unavailable')
      }
    })
  }
  const methods = Object.fromEntries(
    MEMORY_METHODS.map((method) => [method, (...args: unknown[]) => call(method, args)]),
  ) as BrainMemoryClient
  methods.close = () => {
    closing ??= call('close', []).then(
      () => {
        stop('Brain database closed')
      },
      (error: unknown) => {
        stop('Brain database closed')
        throw error
      },
    )
    return closing
  }
  return methods
}
