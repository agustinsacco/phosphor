/**
 * The slice of `sherpa-onnx` (the WebAssembly build; it ships no types) that
 * `engine.ts` uses. It is CommonJS, so it is imported as a default. Model
 * paths are read straight from disk (Emscripten NODERAWFS).
 */
declare module 'sherpa-onnx' {
  interface OfflineStream {
    acceptWaveform(sampleRate: number, samples: Float32Array): void
    free(): void
  }
  interface OfflineRecognizer {
    createStream(): OfflineStream
    decode(stream: OfflineStream): void
    getResult(stream: OfflineStream): { text: string }
    free(): void
  }
  interface Vad {
    acceptWaveform(samples: Float32Array): void
    isEmpty(): boolean
    front(): { samples: Float32Array; start: number }
    pop(): void
    flush(): void
    reset(): void
    free(): void
  }
  interface VadModelConfig {
    model: string
    threshold: number
    minSilenceDuration: number
    minSpeechDuration: number
    maxSpeechDuration: number
    windowSize: number
  }
  const sherpa: {
    createOfflineRecognizer(config: {
      modelConfig: {
        moonshine: { encoder: string; mergedDecoder: string }
        tokens: string
        numThreads: number
        debug: number
      }
    }): OfflineRecognizer
    createVad(config: {
      sileroVad: VadModelConfig
      tenVad: VadModelConfig
      sampleRate: number
      numThreads: number
      provider: string
      debug: number
      bufferSizeInSeconds: number
    }): Vad
  }
  export default sherpa
}
