import type { EmbeddingRequest, FromEmbeddingWorker, ToEmbeddingWorker } from './embedding-protocol'

/** The utility process, as main sees it. */
export interface EmbeddingProcess {
  post(message: ToEmbeddingWorker): void
  onMessage(listener: (message: FromEmbeddingWorker) => void): void
  onExit(listener: () => void): void
  kill(): void
}

interface Pending {
  resolve(message: FromEmbeddingWorker): void
  reject(error: Error): void
}

export function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error('Embedding was cancelled')
}

/** `promise`, or a rejection as soon as `signal` aborts. The work itself is not stopped. */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal))
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/**
 * One embedding utility process and the requests in flight to it.
 *
 * Every request has an id, a deadline and an optional abort signal. A missed
 * deadline kills the process (a hung native call cannot be interrupted any
 * other way) and fails everything pending; so does the process exiting. An
 * abort fails only its own request and tells the worker to skip it if it
 * has not started. A closed client never spawns again: callers make a new one.
 */
export class EmbeddingClient {
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  /** Why the client closed; also the error for any request made afterwards. */
  private closedReason: string | null = null

  constructor(
    private readonly process: EmbeddingProcess,
    private readonly onClosed: (reason: string) => void,
  ) {
    process.onMessage((message) => this.settle(message))
    process.onExit(() => this.close('The embedding process exited'))
  }

  get alive(): boolean {
    return this.closedReason === null
  }

  request(
    body: EmbeddingRequest,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<FromEmbeddingWorker> {
    if (this.closedReason !== null) return Promise.reject(new Error(this.closedReason))
    if (signal?.aborted) return Promise.reject(abortError(signal))
    const id = this.nextId++
    return new Promise<FromEmbeddingWorker>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.pending.delete(id)
      }
      const onAbort = (): void => {
        cleanup()
        if (this.alive) this.process.post({ type: 'cancel', id })
        reject(abortError(signal))
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`The embedding process did not answer within ${timeoutMs / 1000} s`))
        this.close('The embedding process timed out')
      }, timeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve: (message) => {
          cleanup()
          if (message.type === 'error') reject(new Error(message.message))
          else resolve(message)
        },
        reject: (error) => {
          cleanup()
          reject(error)
        },
      })
      this.process.post({ ...body, id })
    })
  }

  /** Fail everything pending and kill the process. Idempotent. */
  close(reason = 'The embedding process stopped'): void {
    if (this.closedReason !== null) return
    this.closedReason = reason
    for (const pending of [...this.pending.values()]) pending.reject(new Error(reason))
    this.pending.clear()
    this.process.kill()
    this.onClosed(reason)
  }

  private settle(message: FromEmbeddingWorker): void {
    // A late reply to a request that was cancelled or timed out.
    this.pending.get(message.id)?.resolve(message)
  }
}
