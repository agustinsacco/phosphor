import { mkdtempSync } from 'node:fs'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrainEmbeddingStatus } from '@phosphor/shared/brain'
import {
  fakeFetch,
  fakeTransformers,
  FakeEmbeddingProcess,
  SMALL_CONTENT,
  type FakeTransformersOptions,
} from './__fixtures__/embedding-fakes'
import { createEmbeddingController, EMBEDDING_IDLE_MS } from './embedding-controller'
import { embeddingModelPaths } from './embedding-files'
import type * as Manifest from './model-manifest'

vi.mock('./model-manifest', async (importOriginal) => {
  const real = await importOriginal<typeof Manifest>()
  const fakes = await import('./__fixtures__/embedding-small-files')
  return {
    ...real,
    EMBEDDING_MODEL: { ...real.EMBEDDING_MODEL, files: fakes.SMALL_FILES },
    EMBEDDING_TOTAL_BYTES: fakes.SMALL_TOTAL,
  }
})

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'brain-embeddings-'))
})
afterEach(async () => {
  vi.useRealTimers()
  await rm(directory, { recursive: true, force: true })
})

function setup(
  options: { supported?: boolean; model?: FakeTransformersOptions; fetch?: typeof fetch } = {},
) {
  const phases: BrainEmbeddingStatus['phase'][] = []
  const processes: FakeEmbeddingProcess[] = []
  const fake = fakeTransformers(options.model)
  const net = fakeFetch()
  const embeddings = createEmbeddingController({
    directory,
    supported: options.supported ?? true,
    threads: 2,
    fetch: options.fetch ?? net.fetch,
    onStatus: (status) => {
      if (phases.at(-1) !== status.phase) phases.push(status.phase)
    },
    spawn: () => {
      const process = new FakeEmbeddingProcess(fake.tf)
      processes.push(process)
      return process
    },
  })
  return { embeddings, phases, processes, fake, net, paths: embeddingModelPaths(directory) }
}

async function ready(options: Parameters<typeof setup>[0] = {}) {
  const env = setup(options)
  await env.embeddings.setEnabled(true)
  await env.embeddings.download()
  expect(env.embeddings.status().phase).toBe('ready')
  env.phases.length = 0
  env.net.urls.length = 0
  return env
}

describe('setup', () => {
  it('reports the shared model identity and starts off', () => {
    const { embeddings } = setup()
    expect(embeddings.status()).toEqual({
      phase: 'missing',
      receivedBytes: 0,
      totalBytes: 0,
      modelId: 'embeddinggemma-300m-q4@5090578d9565bb06545b4552f76e6bc2c93e4a66',
      dimensions: 768,
    })
  })

  it('isolates status snapshots and cannot restart work after disposal', async () => {
    const { embeddings, net, processes } = setup()
    const snapshot = embeddings.status()
    snapshot.phase = 'ready'
    expect(embeddings.status().phase).toBe('missing')
    embeddings.dispose()
    await embeddings.setEnabled(true)
    await expect(embeddings.download()).rejects.toThrow('Turn on Brain')
    expect(net.urls).toEqual([])
    expect(processes).toEqual([])
  })

  it('enabling with nothing on disk downloads and self-tests automatically', async () => {
    const { embeddings, net, processes, phases } = setup()
    await embeddings.setEnabled(true)
    expect(phases).toEqual(['verifying', 'downloading', 'verifying', 'testing', 'ready'])
    expect(net.urls).toHaveLength(3)
    expect(processes).toHaveLength(1)
  })

  it('downloads only with Brain enabled', async () => {
    const { embeddings, net } = setup()
    await expect(embeddings.download()).rejects.toThrow(/Turn on Brain/)
    expect(net.urls).toEqual([])
  })

  it('goes download → verify → self-test → ready, with prefixed invented text', async () => {
    const { embeddings, phases, net, fake } = setup()
    await embeddings.setEnabled(true)
    await embeddings.download()
    expect(phases).toEqual(['verifying', 'downloading', 'verifying', 'testing', 'ready'])
    expect(net.urls).toHaveLength(3)
    expect(fake.tokenized[0]![0]).toMatch(/^task: search result \| query: /)
    expect(fake.tokenized[0]![1]).toMatch(/^title: none \| text: /)
    expect(embeddings.status()).toMatchObject({ receivedBytes: expect.any(Number) as number })
  })

  it('a self-test that cannot tell inputs apart is an error, not ready', async () => {
    const { embeddings } = setup({ model: { identical: true } })
    await embeddings.setEnabled(true)
    await embeddings.download()
    expect(embeddings.status()).toMatchObject({ phase: 'error', error: /not distinguished/ })
    await expect(embeddings.embed(['a'], 'query')).rejects.toThrow(/not ready/)
  })

  it('a failed download is an error that a second download retries', async () => {
    const { embeddings, net } = setup()
    net.override['config.json'] = Buffer.from('{"MODEL_TYPE":"GEMMA3_TEXT"}')
    await embeddings.setEnabled(true)
    expect(embeddings.status()).toMatchObject({ phase: 'error', error: /^Local embeddings failed/ })
    delete net.override['config.json']
    await embeddings.download()
    expect(embeddings.status().phase).toBe('ready')
  })

  it('on an unsupported platform stays unsupported and never downloads', async () => {
    const { embeddings, net, processes } = setup({ supported: false })
    await embeddings.setEnabled(true)
    expect(embeddings.status().phase).toBe('unsupported')
    await expect(embeddings.download()).rejects.toThrow(/not supported/)
    await expect(embeddings.embed(['a'], 'query')).rejects.toThrow(/not ready/)
    expect(net.urls).toEqual([])
    expect(processes).toEqual([])
  })
})

describe('enable, disable and remove', () => {
  it('disabling during a download aborts the network request and never publishes ready', async () => {
    let requested!: () => void
    const started = new Promise<void>((resolve) => {
      requested = resolve
    })
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          requested()
          init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')), {
            once: true,
          })
        }),
    )
    const { embeddings, paths, phases } = setup({ fetch })
    const download = embeddings.setEnabled(true)
    await started
    expect(embeddings.status().phase).toBe('downloading')
    await embeddings.setEnabled(false)
    await download
    expect(fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true)
    expect(embeddings.status().phase).toBe('missing')
    expect(phases).not.toContain('ready')
    expect(await stat(paths.model).catch(() => null)).toBeNull()
  })

  it('disabling unloads the worker and keeps the files; enabling verifies without network', async () => {
    const { embeddings, processes, phases, net, paths } = await ready()
    await embeddings.setEnabled(false)
    expect(processes.every((process) => process.killed)).toBe(true)
    expect(await stat(paths.model)).toBeTruthy()
    await embeddings.setEnabled(true)
    expect(phases).toEqual(['ready', 'verifying', 'testing', 'ready'])
    expect(net.urls).toEqual([])
  })

  it('enabling over same-size corruption is an error; download repairs only that file', async () => {
    const { embeddings, paths, net } = await ready()
    await embeddings.setEnabled(false)
    const bad = Buffer.from(SMALL_CONTENT['tokenizer.json']!)
    bad[0] = bad[0]! ^ 0xff
    await writeFile(join(paths.model, 'tokenizer.json'), bad)
    await embeddings.setEnabled(true)
    expect(embeddings.status()).toMatchObject({ phase: 'error', error: /tokenizer.json/ })
    await embeddings.download()
    expect(embeddings.status().phase).toBe('ready')
    expect(net.urls).toEqual(['https://models.test/tokenizer.json'])
    expect(await readFile(join(paths.model, 'tokenizer.json'))).toEqual(
      SMALL_CONTENT['tokenizer.json'],
    )
  })

  it('remove deletes the files and unloads, leaving missing while enabled', async () => {
    const { embeddings, paths, processes } = await ready()
    await embeddings.remove()
    expect(embeddings.status().phase).toBe('missing')
    expect(await stat(paths.model).catch(() => null)).toBeNull()
    expect(processes.every((process) => process.killed)).toBe(true)
  })
})

describe('embed', () => {
  it('embeds in bounded batches and returns unit vectors in order', async () => {
    const { embeddings, fake } = await ready()
    fake.tokenized.length = 0
    const texts = Array.from({ length: 20 }, (_, i) => `note ${i}`)
    const vectors = await embeddings.embed(texts, 'document')
    expect(fake.tokenized.map((batch) => batch.length)).toEqual([16, 4])
    expect(fake.tokenized[0]![0]).toBe('title: none | text: note 0')
    expect(vectors).toHaveLength(20)
    expect(Math.hypot(...vectors[0]!)).toBeCloseTo(1, 6)
    expect(await embeddings.embed([], 'query')).toEqual([])
    await expect(embeddings.embed(new Array<string>(257).fill('x'), 'query')).rejects.toThrow(
      /At most 256/,
    )
  })

  it('never downloads, and refuses before ready', async () => {
    const { embeddings, net } = setup()
    await expect(embeddings.embed(['a'], 'query')).rejects.toThrow(/not ready/)
    expect(net.urls).toEqual([])
  })

  it('a crashed worker fails the call; the next call starts a fresh one', async () => {
    const { embeddings, processes } = await ready()
    const pending = embeddings.embed(['a'], 'query')
    processes.at(-1)!.kill()
    await expect(pending).rejects.toThrow(/exited/)
    await expect(embeddings.embed(['b'], 'query')).resolves.toHaveLength(1)
    expect(processes.filter((process) => !process.killed)).toHaveLength(1)
    expect(embeddings.status().phase).toBe('ready')
  })

  it('honours an abort signal', async () => {
    const { embeddings } = await ready()
    await expect(embeddings.embed(['a'], 'query', AbortSignal.abort())).rejects.toThrow()
  })

  it('unloads the model after the idle period and reloads it on the next call', async () => {
    const { embeddings, processes } = await ready()
    vi.useFakeTimers()
    await embeddings.embed(['a'], 'query')
    vi.advanceTimersByTime(EMBEDDING_IDLE_MS)
    expect(processes.every((process) => process.killed)).toBe(true)
    vi.useRealTimers()
    await expect(embeddings.embed(['b'], 'query')).resolves.toHaveLength(1)
  })

  it('dispose stops the worker and publishes nothing more', async () => {
    const { embeddings, processes, phases } = await ready()
    embeddings.dispose()
    expect(processes.every((process) => process.killed)).toBe(true)
    await embeddings.setEnabled(true)
    expect(phases).toEqual([])
  })
})
