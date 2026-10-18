import type { VoicePrefs, VoiceStatus } from '@shared/voice'
import { downloadFiles, filesPresent, pruneDir } from './download'
import { VOICE_MANIFEST } from './manifest'
import type { VoicePorts } from './service'
import type { VoiceServiceState } from './service-state'

export class VoiceModelService {
  constructor(
    private readonly state: VoiceServiceState,
    private readonly ports: VoicePorts,
    private readonly unload: () => void,
  ) {}

  async ensureModel(): Promise<VoiceStatus> {
    const model = this.state.status.prefs.model
    const files = VOICE_MANIFEST[model]
    const keep = files.map((file) => file.path)
    const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)
    /** False once a disable or a model switch has overtaken this call. */
    const current = (): boolean =>
      this.state.status.prefs.enabled && this.state.status.prefs.model === model
    // Already on its way (a second click on enable, a retry mid-download).
    if (this.state.download?.model === model) return this.state.status
    this.state.download?.controller.abort()
    this.state.download = null
    if (await filesPresent(this.ports.dir, files)) {
      if (!current()) return this.state.status
      await pruneDir(this.ports.dir, keep)
      return this.state.set({ phase: 'ready', receivedBytes: totalBytes, totalBytes })
    }
    if (!current() || this.state.download) return this.state.status
    const controller = new AbortController()
    this.state.download = { controller, model }
    this.state.set({ phase: 'downloading', receivedBytes: 0, totalBytes })
    let published = 0
    try {
      await downloadFiles(this.ports.dir, files, {
        signal: controller.signal,
        fetch: this.ports.fetch,
        onProgress: (receivedBytes) => {
          // ~1 MB steps: per-chunk updates would flood every window.
          if (receivedBytes - published < 1_000_000 && receivedBytes < totalBytes) return
          published = receivedBytes
          this.state.set({ receivedBytes })
        },
      })
    } catch (error) {
      // Superseded by a model switch or a disable, which set their own phase.
      if (controller.signal.aborted) return this.state.status
      this.state.download = null
      this.ports.log?.(`voice download failed: ${String(error)}`)
      return this.state.set({
        phase: 'error',
        error: `Download failed: ${(error as Error).message}`,
      })
    }
    if (this.state.download?.controller === controller) this.state.download = null
    if (!current()) return this.state.status
    await pruneDir(this.ports.dir, keep)
    return this.state.set({ phase: 'ready', receivedBytes: totalBytes, totalBytes })
  }

  async setPrefs(prefs: VoicePrefs): Promise<VoiceStatus> {
    if (prefs.model !== this.state.status.prefs.model || !prefs.enabled) this.unload()
    this.ports.savePrefs(prefs)
    this.state.set({ prefs })
    if (prefs.enabled) return this.ensureModel()
    this.state.download?.controller.abort()
    this.state.download = null
    await pruneDir(this.ports.dir, [])
    return this.state.set({ phase: 'off', receivedBytes: 0, totalBytes: 0 })
  }
}
