import { expect, it, vi } from 'vitest'

const fork = vi.fn()
vi.mock('electron', () => ({ utilityProcess: { fork }, app: { getPath: () => '/tmp' } }))

const { createBrainEmbeddings, embeddingWorkerEnv } = await import('./embedding-service')

it('starts off where the native runtime is verified, unsupported elsewhere, and spawns nothing', () => {
  const embeddings = createBrainEmbeddings({ directory: '/nowhere', workerPath: '/out/w.js' })
  const supported = process.platform === 'darwin' && process.arch === 'arm64'
  expect(embeddings.status().phase).toBe(supported ? 'missing' : 'unsupported')
  expect(fork).not.toHaveBeenCalled()
  embeddings.dispose()
})

it('keeps Hugging Face credentials out of the worker environment', () => {
  expect(embeddingWorkerEnv({ PATH: '/bin', HF_TOKEN: 'a', HF_ACCESS_TOKEN: 'b' })).toEqual({
    PATH: '/bin',
  })
})
