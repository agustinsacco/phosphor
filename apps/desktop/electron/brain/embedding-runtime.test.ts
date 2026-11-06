import { describe, expect, it } from 'vitest'
import { fakeTransformers } from './__fixtures__/embedding-fakes'
import { configureLocalOnly, loadEmbeddingRuntime, unitRows } from './embedding-runtime'

const CONFIG = { modelRoot: '/data/embedding-models', modelName: 'gemma-dir', threads: 3 }

describe('configureLocalOnly', () => {
  it('loads from the model root only, with no cache and no network', async () => {
    const { tf } = fakeTransformers()
    configureLocalOnly(tf, CONFIG.modelRoot)
    expect(tf.env).toMatchObject({
      allowRemoteModels: false,
      allowLocalModels: true,
      localModelPath: '/data/embedding-models/',
      useFSCache: false,
      useBrowserCache: false,
      useCustomCache: false,
      useWasmCache: false,
    })
    await expect(tf.env.fetch('https://huggingface.co/x')).rejects.toThrow(/never use the network/)
  })
})

describe('loadEmbeddingRuntime', () => {
  it('loads q4 on the native CPU backend, local files only, with bounded threads', async () => {
    const { tf, loads } = fakeTransformers()
    await loadEmbeddingRuntime(CONFIG, tf)
    expect(loads).toEqual([
      { kind: 'tokenizer', id: 'gemma-dir', options: { local_files_only: true } },
      {
        kind: 'model',
        id: 'gemma-dir',
        options: {
          local_files_only: true,
          dtype: 'q4',
          device: 'cpu',
          session_options: { intraOpNumThreads: 3, interOpNumThreads: 1 },
        },
      },
    ])
  })

  it('returns one unit-length 768-dimension row per text', async () => {
    const { tf, tokenized } = fakeTransformers()
    const runtime = await loadEmbeddingRuntime(CONFIG, tf)
    const rows = await runtime.embed(['alpha', 'beta'])
    expect(tokenized).toEqual([['alpha', 'beta']])
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row).toHaveLength(768)
      expect(Math.hypot(...row)).toBeCloseTo(1, 6)
    }
  })
})

describe('unitRows', () => {
  it('rejects a wrong width, a wrong rank and a zero vector', () => {
    expect(() => unitRows({ dims: [1, 384], data: new Array<number>(384).fill(1) })).toThrow(
      /Unexpected embedding shape \[1, 384\]/,
    )
    expect(() => unitRows({ dims: [768], data: new Array<number>(768).fill(1) })).toThrow(/shape/)
    expect(() => unitRows({ dims: [1, 768], data: new Array<number>(768).fill(0) })).toThrow(
      /not a finite vector/,
    )
  })
})
