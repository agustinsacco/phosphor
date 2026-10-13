import { VOICE_SAMPLE_RATE } from '@shared/voice'
import workletUrl from './pcmWorklet?worker&url'

/** Samples per chunk sent to main: 100 ms. */
const CHUNK_SAMPLES = VOICE_SAMPLE_RATE / 10

export interface MicCapture {
  /** Stop recording. The last partial chunk is delivered before it resolves. */
  stop(): Promise<void>
}

/**
 * Record the default microphone as 16 kHz mono float samples, in 100 ms
 * chunks. Chromium resamples from the device rate; nothing is played back.
 */
export async function openMic(onChunk: (samples: Float32Array) => void): Promise<MicCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  })
  const context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE })
  const release = async (): Promise<void> => {
    for (const track of stream.getTracks()) track.stop()
    await context.close().catch(() => undefined)
  }
  try {
    await context.audioWorklet.addModule(workletUrl)
  } catch (error) {
    await release()
    throw error
  }
  const source = context.createMediaStreamSource(stream)
  // No outputs: the node is still rendered, and nothing reaches the speakers.
  const node = new AudioWorkletNode(context, 'phosphor-pcm', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
  })
  const pending = new Float32Array(CHUNK_SAMPLES)
  let filled = 0
  node.port.onmessage = ({ data }: MessageEvent<Float32Array>) => {
    for (let offset = 0; offset < data.length;) {
      const take = Math.min(data.length - offset, CHUNK_SAMPLES - filled)
      pending.set(data.subarray(offset, offset + take), filled)
      filled += take
      offset += take
      if (filled === CHUNK_SAMPLES) {
        onChunk(pending.slice())
        filled = 0
      }
    }
  }
  source.connect(node)

  return {
    async stop() {
      source.disconnect()
      // Blocks the worklet already posted are still queued on the port.
      await new Promise((resolve) => setTimeout(resolve, 30))
      node.port.onmessage = null
      if (filled > 0) onChunk(pending.slice(0, filled))
      filled = 0
      await release()
    },
  }
}
