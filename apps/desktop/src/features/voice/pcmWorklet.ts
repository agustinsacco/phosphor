/**
 * AudioWorklet that hands the microphone's samples to the page.
 *
 * Runs on the audio thread, so recording never depends on how busy the
 * renderer is. The context already records at 16 kHz mono; this only copies
 * each 128-sample block out (the input buffer is reused by the next call).
 * Loaded by `micCapture.ts` through Vite's `?worker&url`, which bundles it as
 * a standalone script on the app's own origin, as the CSP requires.
 */
declare const AudioWorkletProcessor: { new (): { readonly port: MessagePort } }
declare function registerProcessor(name: string, processor: unknown): void

registerProcessor(
  'phosphor-pcm',
  class extends AudioWorkletProcessor {
    process(inputs: Float32Array[][]): boolean {
      const channel = inputs[0]?.[0]
      if (channel) this.port.postMessage(channel.slice(0))
      return true
    }
  },
)

export {}
