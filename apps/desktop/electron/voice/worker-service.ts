import { join } from 'node:path'
import { VOICE_SAMPLE_RATE } from '@shared/voice'
import { modelFiles, type VoiceModelFiles } from './manifest'
import type { VoicePorts } from './service'
import { deferred, type Loaded, type VoiceServiceState } from './service-state'

/** The loaded model is let go after this long without a dictation. */
export const VOICE_IDLE_MS = 3 * 60_000
/** A chunk the renderer sends is ~100 ms; anything over 5 s is not one. */
const MAX_CHUNK_SAMPLES = VOICE_SAMPLE_RATE * 5
const STOP_TIMEOUT_MS = 60_000

export class VoiceWorkerService {
  constructor(
    private readonly state: VoiceServiceState,
    private readonly ports: VoicePorts,
  ) {}

  unload(): void {
    if (this.state.idleTimer) clearTimeout(this.state.idleTimer)
    this.state.idleTimer = null
    const worker = this.state.loaded?.worker
    this.state.loaded = null
    this.state.owner = null
    this.state.failPending('Voice input stopped')
    worker?.kill()
  }

  armIdle(): void {
    if (this.state.idleTimer) clearTimeout(this.state.idleTimer)
    this.state.idleTimer = setTimeout(() => this.unload(), VOICE_IDLE_MS)
  }

  /** The worker for the selected model, spawning it when needed. Never waits. */
  load(): Loaded {
    const model = this.state.status.prefs.model
    if (this.state.loaded?.model === model) return this.state.loaded
    this.unload()
    const worker = this.ports.spawnWorker()
    const entry: Loaded = { worker, model, ready: deferred() }
    let loading = true
    worker.onMessage((message) => {
      if (message.type === 'loaded') {
        loading = false
        entry.ready.resolve()
      } else if (message.type === 'text') {
        this.state.pending.get(message.id)?.resolve(message.text)
        this.state.pending.delete(message.id)
      } else if (message.id !== undefined) {
        this.state.pending.get(message.id)?.reject(new Error(message.message))
        this.state.pending.delete(message.id)
      } else if (loading) {
        loading = false
        entry.ready.reject(new Error(`Could not load the voice model: ${message.message}`))
      } else {
        this.state.dictationError = message.message
      }
    })
    worker.onExit(() => {
      entry.ready.reject(new Error('The voice process exited'))
      if (this.state.loaded !== entry) return
      this.ports.log?.('voice worker exited')
      this.state.loaded = null
      this.state.owner = null
      this.state.failPending('The voice process exited')
    })
    const files = modelFiles(model)
    const absolute: VoiceModelFiles = {
      encoder: join(this.ports.dir, files.encoder),
      decoder: join(this.ports.dir, files.decoder),
      tokens: join(this.ports.dir, files.tokens),
      vad: join(this.ports.dir, files.vad),
    }
    worker.post({ type: 'load', files: absolute })
    this.state.loaded = entry
    return entry
  }

  /**
   * Returns once the dictation is accepting audio. The model may still be
   * loading: audio queues in the worker behind it, so the first words
   * spoken are not lost to the load.
   */
  async start(windowId: number): Promise<void> {
    if (this.state.status.phase !== 'ready') {
      throw new Error('Voice input is not ready. See Settings → Voice.')
    }
    if (!(await this.ports.allowMicrophone())) {
      throw new Error('Phosphor cannot use the microphone. Allow it in your privacy settings.')
    }
    if (this.state.idleTimer) clearTimeout(this.state.idleTimer)
    const { worker } = this.load()
    if (this.state.owner !== null) worker.post({ type: 'cancel' })
    this.state.owner = windowId
    this.state.dictationError = null
    worker.post({ type: 'begin' })
  }

  audio(windowId: number, samples: Float32Array): void {
    if (this.state.owner !== windowId || !this.state.loaded) return
    if (!(samples instanceof Float32Array) || samples.length > MAX_CHUNK_SAMPLES) return
    this.state.loaded.worker.post({ type: 'audio', samples })
  }

  async stop(windowId: number): Promise<{ text: string }> {
    if (this.state.owner !== windowId || !this.state.loaded) return { text: '' }
    this.state.owner = null
    const current = this.state.loaded
    const id = this.state.nextId++
    const reply = deferred<string>()
    this.state.pending.set(id, reply)
    const timeout = setTimeout(
      () => reply.reject(new Error('Transcription timed out')),
      STOP_TIMEOUT_MS,
    )
    current.worker.post({ type: 'end', id })
    try {
      await current.ready.promise
      const text = await reply.promise
      if (this.state.dictationError) throw new Error(this.state.dictationError)
      return { text }
    } catch (error) {
      // A model that failed to load stays failed: drop it so the next
      // dictation starts a fresh process.
      if (this.state.loaded === current) this.unload()
      throw error
    } finally {
      clearTimeout(timeout)
      this.state.pending.delete(id)
      if (this.state.loaded === current) this.armIdle()
    }
  }

  cancel(windowId: number): void {
    if (this.state.owner !== windowId || !this.state.loaded) return
    this.state.owner = null
    this.state.loaded.worker.post({ type: 'cancel' })
    this.armIdle()
  }
}
