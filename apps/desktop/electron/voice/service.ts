import { join } from 'node:path'
import { VOICE_SAMPLE_RATE, type VoicePrefs, type VoiceStatus } from '@shared/voice'
import { downloadFiles, filesPresent, pruneDir } from './download'
import { VOICE_MANIFEST, modelFiles, type VoiceModelFiles } from './manifest'
import type { FromVoiceWorker, ToVoiceWorker } from './protocol'

/** The utility process, as the service sees it. */
export interface VoiceWorker {
  post(message: ToVoiceWorker): void
  onMessage(listener: (message: FromVoiceWorker) => void): void
  onExit(listener: () => void): void
  kill(): void
}

export interface VoicePorts {
  /** Where model files live (`<userData>/voice`). */
  dir: string
  loadPrefs(): VoicePrefs
  savePrefs(prefs: VoicePrefs): void
  publish(status: VoiceStatus): void
  spawnWorker(): VoiceWorker
  /** Ask the OS for the microphone; false when the user has refused it. */
  allowMicrophone(): Promise<boolean>
  fetch?: typeof fetch
  log?(message: string): void
}

/** The loaded model is let go after this long without a dictation. */
export const VOICE_IDLE_MS = 3 * 60_000
/** A chunk the renderer sends is ~100 ms; anything over 5 s is not one. */
const MAX_CHUNK_SAMPLES = VOICE_SAMPLE_RATE * 5
const STOP_TIMEOUT_MS = 60_000

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: Error): void
}

function deferred<T>(): Deferred<T> {
  const d = {} as Deferred<T>
  d.promise = new Promise<T>((resolve, reject) => Object.assign(d, { resolve, reject }))
  // Awaited later, if at all: an early failure must not read as unhandled.
  d.promise.catch(() => undefined)
  return d
}

interface Loaded {
  worker: VoiceWorker
  model: VoicePrefs['model']
  ready: Deferred<void>
}

/**
 * Voice input in main: prefs, the model download, and dictations.
 *
 * Exactly the selected model is kept on disk while voice is on, and nothing
 * once it is off. The recognizer runs in a utility process that starts with
 * the first dictation and exits after `VOICE_IDLE_MS` without one.
 */
export function createVoiceService(ports: VoicePorts) {
  let status: VoiceStatus = {
    prefs: ports.loadPrefs(),
    phase: 'off',
    receivedBytes: 0,
    totalBytes: 0,
  }
  let download: { controller: AbortController; model: VoicePrefs['model'] } | null = null
  let loaded: Loaded | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  /** The window whose dictation is running, if any. */
  let owner: number | null = null
  /** A failure the worker reported mid-dictation, surfaced by `stop`. */
  let dictationError: string | null = null
  let nextId = 1
  const pending = new Map<number, Deferred<string>>()

  const set = (next: Partial<VoiceStatus>): VoiceStatus => {
    status = { ...status, ...next }
    if (status.phase !== 'error') delete status.error
    ports.publish(status)
    return status
  }

  async function ensureModel(): Promise<VoiceStatus> {
    const model = status.prefs.model
    const files = VOICE_MANIFEST[model]
    const keep = files.map((file) => file.path)
    const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)
    /** False once a disable or a model switch has overtaken this call. */
    const current = (): boolean => status.prefs.enabled && status.prefs.model === model
    // Already on its way (a second click on enable, a retry mid-download).
    if (download?.model === model) return status
    download?.controller.abort()
    download = null
    if (await filesPresent(ports.dir, files)) {
      if (!current()) return status
      await pruneDir(ports.dir, keep)
      return set({ phase: 'ready', receivedBytes: totalBytes, totalBytes })
    }
    if (!current() || download) return status
    const controller = new AbortController()
    download = { controller, model }
    set({ phase: 'downloading', receivedBytes: 0, totalBytes })
    let published = 0
    try {
      await downloadFiles(ports.dir, files, {
        signal: controller.signal,
        fetch: ports.fetch,
        onProgress: (receivedBytes) => {
          // ~1 MB steps: per-chunk updates would flood every window.
          if (receivedBytes - published < 1_000_000 && receivedBytes < totalBytes) return
          published = receivedBytes
          set({ receivedBytes })
        },
      })
    } catch (error) {
      // Superseded by a model switch or a disable, which set their own phase.
      if (controller.signal.aborted) return status
      download = null
      ports.log?.(`voice download failed: ${String(error)}`)
      return set({ phase: 'error', error: `Download failed: ${(error as Error).message}` })
    }
    if (download?.controller === controller) download = null
    if (!current()) return status
    await pruneDir(ports.dir, keep)
    return set({ phase: 'ready', receivedBytes: totalBytes, totalBytes })
  }

  function failPending(message: string): void {
    for (const reply of pending.values()) reply.reject(new Error(message))
    pending.clear()
  }

  function unload(): void {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
    const worker = loaded?.worker
    loaded = null
    owner = null
    failPending('Voice input stopped')
    worker?.kill()
  }

  function armIdle(): void {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(unload, VOICE_IDLE_MS)
  }

  /** The worker for the selected model, spawning it when needed. Never waits. */
  function load(): Loaded {
    const model = status.prefs.model
    if (loaded?.model === model) return loaded
    unload()
    const worker = ports.spawnWorker()
    const entry: Loaded = { worker, model, ready: deferred() }
    let loading = true
    worker.onMessage((message) => {
      if (message.type === 'loaded') {
        loading = false
        entry.ready.resolve()
      } else if (message.type === 'text') {
        pending.get(message.id)?.resolve(message.text)
        pending.delete(message.id)
      } else if (message.id !== undefined) {
        pending.get(message.id)?.reject(new Error(message.message))
        pending.delete(message.id)
      } else if (loading) {
        loading = false
        entry.ready.reject(new Error(`Could not load the voice model: ${message.message}`))
      } else {
        dictationError = message.message
      }
    })
    worker.onExit(() => {
      entry.ready.reject(new Error('The voice process exited'))
      if (loaded !== entry) return
      ports.log?.('voice worker exited')
      loaded = null
      owner = null
      failPending('The voice process exited')
    })
    const files = modelFiles(model)
    const absolute: VoiceModelFiles = {
      encoder: join(ports.dir, files.encoder),
      decoder: join(ports.dir, files.decoder),
      tokens: join(ports.dir, files.tokens),
      vad: join(ports.dir, files.vad),
    }
    worker.post({ type: 'load', files: absolute })
    loaded = entry
    return entry
  }

  return {
    status: (): VoiceStatus => status,

    /** Launch: report what is on disk, and finish a download a quit interrupted. */
    async init(): Promise<VoiceStatus> {
      return status.prefs.enabled ? ensureModel() : set({ phase: 'off' })
    },

    async setPrefs(prefs: VoicePrefs): Promise<VoiceStatus> {
      if (prefs.model !== status.prefs.model || !prefs.enabled) unload()
      ports.savePrefs(prefs)
      set({ prefs })
      if (prefs.enabled) return ensureModel()
      download?.controller.abort()
      download = null
      await pruneDir(ports.dir, [])
      return set({ phase: 'off', receivedBytes: 0, totalBytes: 0 })
    },

    /**
     * Returns once the dictation is accepting audio. The model may still be
     * loading: audio queues in the worker behind it, so the first words
     * spoken are not lost to the load.
     */
    async start(windowId: number): Promise<void> {
      if (status.phase !== 'ready') {
        throw new Error('Voice input is not ready. See Settings → Voice.')
      }
      if (!(await ports.allowMicrophone())) {
        throw new Error('Phosphor cannot use the microphone. Allow it in your privacy settings.')
      }
      if (idleTimer) clearTimeout(idleTimer)
      const { worker } = load()
      if (owner !== null) worker.post({ type: 'cancel' })
      owner = windowId
      dictationError = null
      worker.post({ type: 'begin' })
    },

    audio(windowId: number, samples: Float32Array): void {
      if (owner !== windowId || !loaded) return
      if (!(samples instanceof Float32Array) || samples.length > MAX_CHUNK_SAMPLES) return
      loaded.worker.post({ type: 'audio', samples })
    },

    async stop(windowId: number): Promise<{ text: string }> {
      if (owner !== windowId || !loaded) return { text: '' }
      owner = null
      const current = loaded
      const id = nextId++
      const reply = deferred<string>()
      pending.set(id, reply)
      const timeout = setTimeout(
        () => reply.reject(new Error('Transcription timed out')),
        STOP_TIMEOUT_MS,
      )
      current.worker.post({ type: 'end', id })
      try {
        await current.ready.promise
        const text = await reply.promise
        if (dictationError) throw new Error(dictationError)
        return { text }
      } catch (error) {
        // A model that failed to load stays failed: drop it so the next
        // dictation starts a fresh process.
        if (loaded === current) unload()
        throw error
      } finally {
        clearTimeout(timeout)
        pending.delete(id)
        if (loaded === current) armIdle()
      }
    },

    cancel(windowId: number): void {
      if (owner !== windowId || !loaded) return
      owner = null
      loaded.worker.post({ type: 'cancel' })
      armIdle()
    },

    dispose(): void {
      download?.controller.abort()
      unload()
    },
  }
}

export type VoiceService = ReturnType<typeof createVoiceService>
