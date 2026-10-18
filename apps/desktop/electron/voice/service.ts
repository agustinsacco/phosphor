import type { VoicePrefs, VoiceStatus } from '@shared/voice'
import type { FromVoiceWorker, ToVoiceWorker } from './protocol'
import { VoiceServiceState } from './service-state'
import { VoiceModelService } from './model-service'
import { VoiceWorkerService } from './worker-service'

export { VOICE_IDLE_MS } from './worker-service'

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

/**
 * Voice input in main: prefs, the model download, and dictations.
 *
 * Exactly the selected model is kept on disk while voice is on, and nothing
 * once it is off. The recognizer runs in a utility process that starts with
 * the first dictation and exits after `VOICE_IDLE_MS` without one.
 */
export function createVoiceService(ports: VoicePorts) {
  const state = new VoiceServiceState(ports.loadPrefs(), (status) => ports.publish(status))
  const worker = new VoiceWorkerService(state, ports)
  const model = new VoiceModelService(state, ports, () => worker.unload())
  return {
    status: (): VoiceStatus => state.status,
    /** Launch: report what is on disk, and finish a download a quit interrupted. */
    async init(): Promise<VoiceStatus> {
      return state.status.prefs.enabled ? model.ensureModel() : state.set({ phase: 'off' })
    },
    setPrefs: (prefs: VoicePrefs) => model.setPrefs(prefs),
    start: (windowId: number) => worker.start(windowId),
    audio: (windowId: number, samples: Float32Array) => worker.audio(windowId, samples),
    stop: (windowId: number) => worker.stop(windowId),
    cancel: (windowId: number) => worker.cancel(windowId),
    dispose(): void {
      state.download?.controller.abort()
      worker.unload()
    },
  }
}

export type VoiceService = ReturnType<typeof createVoiceService>
