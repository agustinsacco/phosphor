import type { VoicePrefs, VoiceStatus } from '@shared/voice'
import type { VoiceWorker } from './service'

export interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: Error): void
}

export function deferred<T>(): Deferred<T> {
  const d = {} as Deferred<T>
  d.promise = new Promise<T>((resolve, reject) => Object.assign(d, { resolve, reject }))
  // Awaited later, if at all: an early failure must not read as unhandled.
  d.promise.catch(() => undefined)
  return d
}

export interface Loaded {
  worker: VoiceWorker
  model: VoicePrefs['model']
  ready: Deferred<void>
}

export class VoiceServiceState {
  status: VoiceStatus
  download: { controller: AbortController; model: VoicePrefs['model'] } | null = null
  loaded: Loaded | null = null
  idleTimer: ReturnType<typeof setTimeout> | null = null
  /** The window whose dictation is running, if any. */
  owner: number | null = null
  /** A failure the worker reported mid-dictation, surfaced by `stop`. */
  dictationError: string | null = null
  nextId = 1
  readonly pending = new Map<number, Deferred<string>>()

  constructor(
    prefs: VoicePrefs,
    private readonly publish: (status: VoiceStatus) => void,
  ) {
    this.status = { prefs, phase: 'off', receivedBytes: 0, totalBytes: 0 }
  }

  set(next: Partial<VoiceStatus>): VoiceStatus {
    this.status = { ...this.status, ...next }
    if (this.status.phase !== 'error') delete this.status.error
    this.publish(this.status)
    return this.status
  }

  failPending(message: string): void {
    for (const reply of this.pending.values()) reply.reject(new Error(message))
    this.pending.clear()
  }
}
