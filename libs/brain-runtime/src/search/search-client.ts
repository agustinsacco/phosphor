import type { BrainSearchPort } from '../types'
import {
  SEARCH_METHODS,
  type FromSearchWorker,
  type SearchMethod,
  type ToSearchWorker,
} from './search-protocol'

/** The search utility process, as main sees it. */
export interface SearchProcess {
  post(message: ToSearchWorker): void
  onMessage(listener: (message: FromSearchWorker) => void): void
  onExit(listener: () => void): void
  kill(): void
}

export interface SearchClientOptions {
  /** The Brain database the process opens read-only. */
  path: string
  spawn(): SearchProcess
  log?(message: string): void
  /** Deadline per call; `refresh` (a first index load) gets ten times as long. */
  timeoutMs?: number
  now?(): number
}

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

function settle(pending: Map<number, Pending>, message: FromSearchWorker): void {
  const entry = pending.get(message.id)
  if (!entry) return
  clearTimeout(entry.timer)
  pending.delete(message.id)
  if (message.type === 'result') entry.resolve(message.value)
  else entry.reject(new Error(message.error))
}

const RESTARTS = 3
const RESTART_WINDOW_MS = 60_000

/**
 * Brain search hosted in its own process: main never scans vectors or walks the graph. The
 * process starts on the first call. A missed deadline kills it (a stuck scan cannot be
 * interrupted another way) and fails what is pending; so does the process exiting. The next call
 * starts a fresh one, at most three times a minute, so a process that crashes on open cannot
 * spin. After `close` every call fails.
 */
export function createSearchClient(options: SearchClientOptions): BrainSearchPort {
  const timeoutMs = options.timeoutMs ?? 30_000
  const now = options.now ?? Date.now
  const pending = new Map<number, Pending>()
  const starts: number[] = []
  let child: SearchProcess | null = null
  let closed = false
  let nextId = 1

  const failAll = (reason: string): void => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer)
      pending.delete(id)
      entry.reject(new Error(reason))
    }
  }
  const stop = (reason: string): void => {
    const current = child
    child = null
    failAll(reason)
    current?.kill()
  }
  const start = (): SearchProcess => {
    if (child) return child
    const recent = starts.filter((at) => now() - at < RESTART_WINDOW_MS)
    if (recent.length >= RESTARTS)
      throw new Error('Brain search keeps stopping; it will retry in a minute.')
    starts.splice(0, starts.length, ...recent, now())
    const spawned = options.spawn()
    child = spawned
    spawned.onMessage((message) => settle(pending, message))
    spawned.onExit(() => {
      if (child !== spawned) return
      options.log?.('Brain search process exited')
      child = null
      failAll('Brain search stopped; try again.')
    })
    spawned.post({ type: 'open', path: options.path })
    return spawned
  }
  const call = (method: SearchMethod, args: unknown[]): Promise<unknown> => {
    if (closed) return Promise.reject(new Error('Brain search is closed.'))
    let target: SearchProcess
    try {
      target = start()
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
    const id = nextId++
    return new Promise((resolve, reject) => {
      const limit = method === 'refresh' ? timeoutMs * 10 : timeoutMs
      const timer = setTimeout(() => {
        options.log?.(`Brain search ${method} missed its ${limit} ms deadline`)
        stop('Brain search took too long; try again.')
      }, limit)
      pending.set(id, { resolve, reject, timer })
      target.post({ type: 'call', id, method, args })
    })
  }

  const port = Object.fromEntries(
    SEARCH_METHODS.map((method) => [method, (...args: unknown[]) => call(method, args)]),
  ) as Omit<BrainSearchPort, 'close'>
  return {
    ...port,
    close: () => {
      if (!closed) {
        closed = true
        child?.post({ type: 'close' })
        stop('Brain search is closed.')
      }
      return Promise.resolve()
    },
  }
}
