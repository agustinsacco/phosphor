import { afterEach, expect, it, vi } from 'vitest'
import { createBrainService } from './service'
import { pipelineSetup } from './__fixtures__/pipeline'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

/** A read waiting in review, read at knowledge revision 0. */
async function setup() {
  const s = await pipelineSetup()
  cleanups.push(s.cleanup)
  s.store.jobs = []
  const service = await createBrainService(s.options)
  cleanups.push(() => service.dispose())
  const id = (await service.api.queue({ sessionPath: s.file, title: 'Harbor' })).jobs[0]!.id
  await vi.waitFor(() => expect(s.store.job(id)?.state).toBe('review'))
  s.runner.mockClear()
  return { ...s, service, id, update: vi.spyOn(s.store, 'updateJob') }
}

it('shows a stale read as stored, and viewing it never starts a refresh', async () => {
  const s = await setup()
  s.store.rev++
  await expect(s.service.api.proposal(s.id)).resolves.toMatchObject({ revision: 0 })
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(s.store.job(s.id)?.state).toBe('review')
  expect(s.update.mock.calls.some(([, patch]) => patch.state === 'refreshing')).toBe(false)
  expect(s.runner).not.toHaveBeenCalled()
})

it('shows the stored read while Brain Agent’s refresh of it runs', async () => {
  const s = await setup()
  // The refresh cannot finish while the model is not ready.
  vi.spyOn(s.options.embeddings, 'status').mockReturnValue({
    phase: 'downloading',
    receivedBytes: 0,
    totalBytes: 1,
    modelId: 'fake',
    dimensions: 768,
  })
  s.store.updateJob(s.id, { state: 'refreshing' })
  await expect(s.service.api.proposal(s.id)).resolves.toMatchObject({ revision: 0 })
  s.store.rev++
  await expect(s.service.api.proposal(s.id)).resolves.toMatchObject({ revision: 0 })
  expect(s.store.job(s.id)?.state).toBe('refreshing')
})
