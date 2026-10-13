import type { VoiceModelFiles } from './manifest'

/** Main → voice utility process. Handled strictly in order. */
export type ToVoiceWorker =
  /** Absolute paths. Replies `loaded` or `error`. */
  | { type: 'load'; files: VoiceModelFiles }
  | { type: 'begin' }
  | { type: 'audio'; samples: Float32Array }
  /** Replies `text` (or `error`) with the same id. */
  | { type: 'end'; id: number }
  | { type: 'cancel' }

/** Voice utility process → main. */
export type FromVoiceWorker =
  | { type: 'loaded' }
  | { type: 'text'; id: number; text: string }
  /** `id` is set when the failure answers an `end`. */
  | { type: 'error'; message: string; id?: number }
