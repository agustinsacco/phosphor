import type { VoiceModelId } from '@shared/voice'

/**
 * Where each voice model comes from, pinned.
 *
 * Every file is fetched by itself (no archive to unpack) from an immutable
 * location: a Hugging Face commit, or a GitHub release asset whose content
 * the SHA-256 pins regardless. A file whose hash differs is discarded, never
 * loaded. The Moonshine files are the sherpa-onnx maintainers' ONNX exports
 * of Moonshine v2 (MIT); the hashes match their `asr-models` release archives.
 * Silero VAD (MIT) splits speech into the short segments Moonshine accepts:
 * it returns nothing for one longer than about 10 seconds.
 */
export interface VoiceFile {
  /** Relative to the voice directory. */
  path: string
  url: string
  sha256: string
  bytes: number
}

/** What the worker loads, as paths relative to the voice directory. */
export interface VoiceModelFiles {
  encoder: string
  decoder: string
  tokens: string
  vad: string
}

const HF = 'https://huggingface.co/csukuangfj2'
const TINY = 'sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27'
const TINY_REV = 'd1e6c30921780b8508d04b492dfb3ce8a51605d4'
const BASE = 'sherpa-onnx-moonshine-base-en-quantized-2026-02-27'
const BASE_REV = '8f4d6c58c03d40bcea40043bb7120a878f2bbef6'
const TOKENS_SHA256 = '2870d843e14c1e187bf1913a521562a63b53933814bd7f2145120468f494a049'

const VAD: VoiceFile = {
  path: 'silero_vad.onnx',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
  sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
  bytes: 643_854,
}

function hf(
  repo: string,
  rev: string,
  model: VoiceModelId,
  name: string,
): Omit<VoiceFile, 'sha256' | 'bytes'> {
  return { path: `${model}/${name}`, url: `${HF}/${repo}/resolve/${rev}/${name}` }
}

export const VOICE_MANIFEST: Record<VoiceModelId, VoiceFile[]> = {
  'moonshine-tiny-en': [
    {
      ...hf(TINY, TINY_REV, 'moonshine-tiny-en', 'encoder_model.ort'),
      sha256: '94e90a4654fc45cdfedb77c4c08e1739f48862998e58fada384b25118134f221',
      bytes: 13_281_600,
    },
    {
      ...hf(TINY, TINY_REV, 'moonshine-tiny-en', 'decoder_model_merged.ort'),
      sha256: 'cf524c4862d36e9e5ab032eddc73637efd822d70e868ac575cf1a46e1e4708a0',
      bytes: 30_412_256,
    },
    {
      ...hf(TINY, TINY_REV, 'moonshine-tiny-en', 'tokens.txt'),
      sha256: TOKENS_SHA256,
      bytes: 549_350,
    },
    VAD,
  ],
  'moonshine-base-en': [
    {
      ...hf(BASE, BASE_REV, 'moonshine-base-en', 'encoder_model.ort'),
      sha256: '7c66495948d0d08ec1af454cd4b5514862ae6511e94712a60e6d83eaec8dc8cf',
      bytes: 31_326_816,
    },
    {
      ...hf(BASE, BASE_REV, 'moonshine-base-en', 'decoder_model_merged.ort'),
      sha256: 'd9d7b333af34bc552580576ddcf248a1c6c839e0d3b43b09afb9376ed009899d',
      bytes: 109_424_400,
    },
    {
      ...hf(BASE, BASE_REV, 'moonshine-base-en', 'tokens.txt'),
      sha256: TOKENS_SHA256,
      bytes: 549_350,
    },
    VAD,
  ],
}

export function modelFiles(model: VoiceModelId): VoiceModelFiles {
  return {
    encoder: `${model}/encoder_model.ort`,
    decoder: `${model}/decoder_model_merged.ort`,
    tokens: `${model}/tokens.txt`,
    vad: VAD.path,
  }
}
