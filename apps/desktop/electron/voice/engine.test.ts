import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { VOICE_SAMPLE_RATE } from '@shared/voice'
import { Dictation } from './dictation'
import { downloadFiles } from './download'
import { createSherpaEngine } from './engine'
import { VOICE_MANIFEST, modelFiles } from './manifest'

/**
 * The real model end to end: download (pinned, verified), load in sherpa-onnx's
 * WebAssembly build, and transcribe a known recording through the detector.
 * Opt-in, because it fetches ~45 MB the first time (cached in the temp dir):
 *
 *   PHOSPHOR_VOICE_INTEGRATION=1 npx vitest run apps/desktop/electron/voice/engine.test.ts
 */
const CLIP = {
  path: 'moonshine-tiny-en/test.wav',
  url: 'https://huggingface.co/csukuangfj2/sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27/resolve/d1e6c30921780b8508d04b492dfb3ce8a51605d4/test_wavs/0.wav',
  sha256: '148b936b43ce7c546a866e64da059f0458aee2d65e617f16e9d94f06e8d99ed6',
  bytes: 184_608,
}

/** 16-bit mono PCM WAV → float samples at 16 kHz (linear resampling). */
function readClip(data: Buffer): Float32Array {
  const rate = data.readUInt32LE(24)
  const pcm = data.subarray(data.indexOf('data') + 8)
  const source = Float32Array.from(
    { length: pcm.length / 2 },
    (_, i) => pcm.readInt16LE(i * 2) / 32768,
  )
  const out = new Float32Array(Math.floor((source.length * VOICE_SAMPLE_RATE) / rate))
  for (let i = 0; i < out.length; i++) {
    const x = (i * rate) / VOICE_SAMPLE_RATE
    const j = Math.floor(x)
    out[i] = (source[j] ?? 0) * (1 - (x - j)) + (source[j + 1] ?? 0) * (x - j)
  }
  return out
}

describe.skipIf(!process.env.PHOSPHOR_VOICE_INTEGRATION)('sherpa engine (integration)', () => {
  it('transcribes a recording fed in 100 ms chunks', { timeout: 300_000 }, async () => {
    const dir = join(tmpdir(), 'phosphor-voice-integration')
    await downloadFiles(dir, [...VOICE_MANIFEST['moonshine-tiny-en'], CLIP])
    const files = modelFiles('moonshine-tiny-en')
    const engine = await createSherpaEngine({
      encoder: join(dir, files.encoder),
      decoder: join(dir, files.decoder),
      tokens: join(dir, files.tokens),
      vad: join(dir, files.vad),
    })
    const samples = readClip(await readFile(join(dir, CLIP.path)))
    // Twice, with a second of silence between: two segments, one transcript.
    const silence = new Float32Array(VOICE_SAMPLE_RATE)
    const audio = Float32Array.from([...samples, ...silence, ...samples])
    const dictation = new Dictation(engine)
    for (let i = 0; i < audio.length; i += VOICE_SAMPLE_RATE / 10) {
      dictation.feed(audio.subarray(i, i + VOICE_SAMPLE_RATE / 10))
    }
    const text = dictation.finish().toLowerCase()
    expect(text.match(/ask not what your country can do for you/g)).toHaveLength(2)
  })
})
