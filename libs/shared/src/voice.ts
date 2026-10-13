/**
 * Voice input: dictation into the composer with a local speech model.
 *
 * Shared between main (which downloads the model and runs it) and the
 * renderer (which records the microphone and shows the state). The download
 * sources and their hashes are main's alone (`electron/voice/manifest.ts`).
 * See docs/voice.md.
 */

export const VOICE_MODEL_IDS = ['moonshine-tiny-en', 'moonshine-base-en'] as const
export type VoiceModelId = (typeof VOICE_MODEL_IDS)[number]

export interface VoiceModelInfo {
  id: VoiceModelId
  label: string
  detail: string
  /** Every file the model needs on disk, the voice detector included. */
  downloadBytes: number
}

/** First entry is the default. `manifest.test.ts` checks the sizes against the files. */
export const VOICE_MODELS: readonly VoiceModelInfo[] = [
  {
    id: 'moonshine-tiny-en',
    label: 'Moonshine Tiny',
    detail: 'English. Fastest.',
    downloadBytes: 44_887_060,
  },
  {
    id: 'moonshine-base-en',
    label: 'Moonshine Base',
    detail: 'English. More accurate, about twice as slow.',
    downloadBytes: 141_944_420,
  },
]

/** The rate the renderer records at and the model expects. */
export const VOICE_SAMPLE_RATE = 16_000

export interface VoicePrefs {
  enabled: boolean
  model: VoiceModelId
}

export const DEFAULT_VOICE_PREFS: VoicePrefs = {
  // Off by default: turning it on is a download and a microphone.
  enabled: false,
  model: 'moonshine-tiny-en',
}

/** Prefs are user-editable JSON: anything unrecognised reads as the default. */
export function normalizeVoicePrefs(raw: unknown): VoicePrefs {
  const value = (raw ?? {}) as Partial<Record<keyof VoicePrefs, unknown>>
  return {
    enabled: value.enabled === true,
    model: VOICE_MODEL_IDS.includes(value.model as VoiceModelId)
      ? (value.model as VoiceModelId)
      : DEFAULT_VOICE_PREFS.model,
  }
}

export interface VoiceStatus {
  prefs: VoicePrefs
  /**
   * `off`: disabled, nothing on disk. `downloading`: the selected model is
   * being fetched. `ready`: verified on disk; dictation can start. `error`:
   * the last download failed (`error` says why); enabling again retries.
   */
  phase: 'off' | 'downloading' | 'ready' | 'error'
  receivedBytes: number
  totalBytes: number
  error?: string
}
