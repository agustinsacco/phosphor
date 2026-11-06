import { describe, expect, it } from 'vitest'
import { BRAIN_EMBEDDING_MODEL } from '@phosphor/shared/brain'
import {
  EMBEDDING_MAX_CHARS,
  EMBEDDING_MODEL,
  EMBEDDING_TOTAL_BYTES,
  embeddingInput,
  embeddingPlatformSupported,
  embeddingThreads,
} from './model-manifest'

describe('EMBEDDING_MODEL', () => {
  it('is the model the UI shows: same id, size and dimensions', () => {
    expect(EMBEDDING_MODEL.id).toBe(BRAIN_EMBEDDING_MODEL.id)
    expect(BRAIN_EMBEDDING_MODEL.id.endsWith(`@${EMBEDDING_MODEL.revision}`)).toBe(true)
    expect(EMBEDDING_TOTAL_BYTES).toBe(BRAIN_EMBEDDING_MODEL.downloadBytes)
    expect(EMBEDDING_MODEL.dimensions).toBe(768)
  })

  it('pins exactly the five files the native q4 runtime loads, by commit, size and hash', () => {
    expect(EMBEDDING_MODEL.files.map((file) => [file.path, file.bytes])).toEqual([
      ['config.json', 1_765],
      ['tokenizer.json', 20_323_312],
      ['tokenizer_config.json', 1_156_830],
      ['onnx/model_q4.onnx', 519_322],
      ['onnx/model_q4.onnx_data', 196_725_760],
    ])
    for (const file of EMBEDDING_MODEL.files) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
      // A branch name would let the content change under the hash.
      expect(file.url).toBe(
        `https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX/resolve/${EMBEDDING_MODEL.revision}/${file.path}`,
      )
    }
    expect(EMBEDDING_MODEL.revision).toMatch(/^[0-9a-f]{40}$/)
  })

  it('names its directory after the revision, so a new revision never mixes files', () => {
    expect(EMBEDDING_MODEL.directoryName).toBe('embeddinggemma-300m-q4-5090578d9565')
  })
})

describe('embedding platform', () => {
  it('supports only darwin arm64, where the native runtime was exercised', () => {
    expect(embeddingPlatformSupported('darwin', 'arm64')).toBe(true)
    expect(embeddingPlatformSupported('darwin', 'x64')).toBe(false)
    expect(embeddingPlatformSupported('linux', 'x64')).toBe(false)
    expect(embeddingPlatformSupported('win32', 'x64')).toBe(false)
  })

  it('bounds CPU threads to half the cores, between 1 and 4', () => {
    expect([1, 2, 6, 12, 64].map(embeddingThreads)).toEqual([1, 1, 3, 4, 4])
  })
})

describe('embeddingInput', () => {
  it('uses the prescribed query and document prompts', () => {
    expect(embeddingInput('who owns billing', 'query')).toBe(
      'task: search result | query: who owns billing',
    )
    expect(embeddingInput('Billing is owned by Ana', 'document')).toBe(
      'title: none | text: Billing is owned by Ana',
    )
  })

  it('bounds the text before tokenizing', () => {
    const input = embeddingInput('x'.repeat(EMBEDDING_MAX_CHARS + 50), 'document')
    expect(input).toBe(`title: none | text: ${'x'.repeat(EMBEDDING_MAX_CHARS)}`)
  })
})
