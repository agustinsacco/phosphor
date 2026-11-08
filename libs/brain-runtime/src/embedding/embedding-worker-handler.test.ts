import { expect, it, vi } from 'vitest'
import { fakeTransformers } from './__fixtures__/embedding-fakes'
import type { FromEmbeddingWorker } from './embedding-protocol'
import { createEmbeddingWorkerHandler } from './embedding-worker-handler'

const LOAD = { type: 'load', id: 1, modelRoot: '/m', modelName: 'gemma', threads: 2 } as const

function setup(options: Parameters<typeof fakeTransformers>[0] = {}) {
  const posted: FromEmbeddingWorker[] = []
  const fake = fakeTransformers(options)
  const importTransformers = vi.fn(() => Promise.resolve(fake.tf))
  const handle = createEmbeddingWorkerHandler({
    post: (message) => posted.push(message),
    importTransformers,
  })
  const settled = () => vi.waitFor(() => expect(posted.length).toBeGreaterThan(0))
  return { posted, handle, importTransformers, settled, fake }
}

it('imports the runtime only when a load arrives, then answers each request by id', async () => {
  const { posted, handle, importTransformers } = setup()
  expect(importTransformers).not.toHaveBeenCalled()
  handle(LOAD)
  handle({ type: 'embed', id: 2, texts: ['a'] })
  await vi.waitFor(() => expect(posted).toHaveLength(2))
  expect(importTransformers).toHaveBeenCalledOnce()
  expect(posted[0]).toEqual({ type: 'done', id: 1 })
  expect(posted[1]).toMatchObject({ type: 'vectors', id: 2 })
})

it('answers an embed before any load with an error, not a crash', async () => {
  const { posted, handle, settled } = setup()
  handle({ type: 'embed', id: 5, texts: ['a'] })
  await settled()
  expect(posted).toEqual([{ type: 'error', id: 5, message: 'The model is not loaded' }])
})

it('reports a failed load against the load request', async () => {
  const { posted, handle, settled } = setup({ loadError: 'file was not found locally' })
  handle(LOAD)
  await settled()
  expect(posted).toEqual([{ type: 'error', id: 1, message: 'file was not found locally' }])
})

it('drops a cancelled request that has not started, and keeps order for the rest', async () => {
  const { posted, handle, fake } = setup()
  handle(LOAD)
  handle({ type: 'embed', id: 2, texts: ['dropped'] })
  handle({ type: 'cancel', id: 2 })
  handle({ type: 'embed', id: 3, texts: ['kept'] })
  await vi.waitFor(() => expect(posted).toHaveLength(2))
  expect(posted.map((message) => message.id)).toEqual([1, 3])
  expect(fake.tokenized).toEqual([['kept']])
})
