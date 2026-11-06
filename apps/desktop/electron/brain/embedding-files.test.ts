import { mkdtempSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeFetch, SMALL_CONTENT, SMALL_FILES } from './__fixtures__/embedding-fakes'
import {
  embeddingModelPaths,
  installEmbeddingModel,
  removeEmbeddingModel,
  unverifiedFiles,
  type EmbeddingModelPaths,
} from './embedding-files'

let directory: string
let paths: EmbeddingModelPaths
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'brain-embedding-'))
  paths = embeddingModelPaths(directory)
})
afterEach(async () => rm(directory, { recursive: true, force: true }))

/** Same length, different bytes: the size check alone cannot see it. */
function corrupt(data: Buffer): Buffer {
  const copy = Buffer.from(data)
  copy[0] = copy[0]! ^ 0xff
  return copy
}

async function writeSet(dir: string, contents: Record<string, Buffer> = SMALL_CONTENT) {
  for (const [path, data] of Object.entries(contents)) {
    await mkdir(join(dir, path, '..'), { recursive: true })
    await writeFile(join(dir, path), data)
  }
}

function install(fetch: typeof globalThis.fetch, signal = new AbortController().signal) {
  return installEmbeddingModel(paths, { signal, fetch, files: SMALL_FILES })
}

describe('embeddingModelPaths', () => {
  it('keeps the model and its staging under <directory>/embedding-models', () => {
    expect(paths.root).toBe(join(directory, 'embedding-models'))
    expect(paths.model).toBe(join(paths.root, 'embeddinggemma-300m-q4-5090578d9565'))
    expect(paths.staging).toBe(join(paths.root, '.staging-embeddinggemma-300m-q4-5090578d9565'))
  })
})

describe('unverifiedFiles', () => {
  it('reports missing, wrong-size and same-size-corrupt files', async () => {
    await writeSet(paths.model, {
      'config.json': SMALL_CONTENT['config.json']!,
      'tokenizer.json': corrupt(SMALL_CONTENT['tokenizer.json']!),
    })
    expect(await unverifiedFiles(paths.model, SMALL_FILES)).toEqual([
      'tokenizer.json',
      'onnx/model_q4.onnx_data',
    ])
    await writeSet(paths.model)
    expect(await unverifiedFiles(paths.model, SMALL_FILES)).toEqual([])
  })
})

describe('installEmbeddingModel', () => {
  it('downloads, verifies and publishes the set with one rename', async () => {
    const { fetch, urls } = fakeFetch()
    await install(fetch)
    expect(urls).toHaveLength(3)
    expect(await unverifiedFiles(paths.model, SMALL_FILES)).toEqual([])
    expect(await stat(paths.staging).catch(() => null)).toBeNull()
  })

  it('publishes nothing when the server sends a file that does not match', async () => {
    const data = SMALL_CONTENT['tokenizer.json']!
    const { fetch } = fakeFetch({ 'tokenizer.json': corrupt(data) })
    await expect(install(fetch)).rejects.toThrow(/tokenizer.json failed verification/)
    expect(await stat(paths.model).catch(() => null)).toBeNull()
    // The verified files stay staged so a retry resumes.
    const staged = await readdir(paths.staging)
    expect(staged).toContain('config.json')
    expect(staged).not.toContain('tokenizer.json')
  })

  it('replaces same-size corruption in staging instead of trusting its size', async () => {
    await writeSet(paths.staging, {
      ...SMALL_CONTENT,
      'onnx/model_q4.onnx_data': corrupt(SMALL_CONTENT['onnx/model_q4.onnx_data']!),
    })
    await writeFile(join(paths.staging, 'config.json.1234abcd.part'), 'stale')
    const { fetch, urls } = fakeFetch()
    await install(fetch)
    expect(urls).toEqual(['https://models.test/onnx/model_q4.onnx_data'])
    expect(await readdir(paths.model)).not.toContain('config.json.1234abcd.part')
    expect(await unverifiedFiles(paths.model, SMALL_FILES)).toEqual([])
  })

  it('repairs a published set that went bad, fetching only the bad file', async () => {
    await writeSet(paths.model, {
      ...SMALL_CONTENT,
      'config.json': corrupt(SMALL_CONTENT['config.json']!),
    })
    const { fetch, urls } = fakeFetch()
    await install(fetch)
    expect(urls).toEqual(['https://models.test/config.json'])
    expect(await readFile(join(paths.model, 'config.json'))).toEqual(SMALL_CONTENT['config.json'])
  })

  it('stops on abort without publishing', async () => {
    const controller = new AbortController()
    const { fetch } = fakeFetch()
    const aborting = (async (input: string | URL | Request, init?: RequestInit) => {
      controller.abort()
      return fetch(input, init)
    }) as typeof globalThis.fetch
    await expect(install(aborting, controller.signal)).rejects.toThrow()
    expect(await stat(paths.model).catch(() => null)).toBeNull()
  })
})

describe('removeEmbeddingModel', () => {
  it('deletes the model and staging, and nothing else in the directory', async () => {
    await writeSet(paths.model)
    await writeSet(paths.staging)
    await writeFile(join(directory, 'brain.sqlite'), 'db')
    await removeEmbeddingModel(paths)
    expect(await readdir(paths.root)).toEqual([])
    expect(await readFile(join(directory, 'brain.sqlite'), 'utf8')).toBe('db')
  })
})
