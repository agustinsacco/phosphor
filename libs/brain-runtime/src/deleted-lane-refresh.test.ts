import { unlink } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { createBrainService } from './service'
import { pipelineSetup } from './__fixtures__/pipeline'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
it('fails a deleted lane refresh once with a remedy, never retries automatically, and allows Reject', async () => {
  const s = await pipelineSetup()
  cleanups.push(s.cleanup)
  s.store.jobs = []
  const service = await createBrainService(s.options)
  cleanups.push(() => service.dispose())
  const id = (await service.api.queue({ sessionPath: s.file, title: 'Harbor' })).jobs[0]!.id
  await vi.waitFor(() => expect(s.store.job(id)?.state).toBe('review'))
  s.runner.mockClear()
  await unlink(s.file)
  s.store.rev++
  await service.api.setPrefs(s.store.prefs)
  await vi.waitFor(() =>
    expect(s.store.job(id)).toMatchObject({
      state: 'failed',
      error: "This lane was deleted, so this review can't be refreshed. Reject it.",
    }),
  )
  const update = vi.spyOn(s.store, 'updateJob')
  await service.api.setPrefs(s.store.prefs)
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(
    update.mock.calls.some(([, patch]) => ['refreshing', 'running'].includes(patch.state ?? '')),
  ).toBe(false)
  await expect(service.api.review(id, null, 0)).resolves.toMatchObject({ jobs: [] })
  expect(s.store.job(id)?.state).toBe('rejected')
  expect(s.runner).not.toHaveBeenCalled()
})
