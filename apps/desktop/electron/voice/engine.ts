import { VOICE_SAMPLE_RATE } from '@shared/voice'
import type { SpeechEngine } from './dictation'
import type { VoiceModelFiles } from './manifest'

/**
 * Silero's settings. `maxSpeechDuration` stays under the ~10 seconds
 * Moonshine v2 accepts: a longer segment transcribes to nothing at all.
 * Past it the detector cuts at the next likely pause.
 */
const VAD = {
  threshold: 0.5,
  minSilenceDuration: 0.3,
  minSpeechDuration: 0.25,
  maxSpeechDuration: 8,
  windowSize: 512,
}

/**
 * Moonshine behind Silero VAD, on sherpa-onnx's WebAssembly build: one
 * package for every platform, so nothing native to build or sign.
 *
 * Imported lazily because importing it instantiates the 12 MB WebAssembly
 * module. Only the voice utility process calls this, never main.
 */
export async function createSherpaEngine(files: VoiceModelFiles): Promise<SpeechEngine> {
  const { default: sherpa } = await import('sherpa-onnx')
  const recognizer = sherpa.createOfflineRecognizer({
    modelConfig: {
      moonshine: { encoder: files.encoder, mergedDecoder: files.decoder },
      tokens: files.tokens,
      numThreads: 1,
      debug: 0,
    },
  })
  const vad = sherpa.createVad({
    sileroVad: { model: files.vad, ...VAD },
    // Unused; the WebAssembly binding reads both blocks.
    tenVad: { model: '', ...VAD, windowSize: 256 },
    sampleRate: VOICE_SAMPLE_RATE,
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
    bufferSizeInSeconds: 30,
  })
  return {
    acceptAudio: (samples) => vad.acceptWaveform(samples),
    flush: () => vad.flush(),
    nextSegment: () => {
      if (vad.isEmpty()) return null
      const segment = vad.front().samples
      vad.pop()
      return segment
    },
    transcribe: (segment) => {
      const stream = recognizer.createStream()
      try {
        stream.acceptWaveform(VOICE_SAMPLE_RATE, segment)
        recognizer.decode(stream)
        return recognizer.getResult(stream).text
      } finally {
        stream.free()
      }
    },
    reset: () => vad.reset(),
  }
}
