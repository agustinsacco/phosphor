import { appendFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { createBrainService } from './service'
import { pipelineSetup } from './__fixtures__/pipeline'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
async function setup() {
  const s = await pipelineSetup()
  cleanups.push(s.cleanup)
  s.store.jobs = []
  vi.spyOn(s.options.embeddings, 'status').mockReturnValue({
    ...s.options.embeddings.status(),
    phase: 'missing',
  })
  const service = await createBrainService(s.options)
  cleanups.push(() => service.dispose())
  const rename = (name: string) =>
    appendFile(s.file, '\n' + JSON.stringify({ type: 'session_info', name }))
  return { ...s, service, rename }
}
const refusal = 'Brain never reads this lane because its title matches a rule in Settings › Brain.'

it('checks the current session_info name when Queue receives an old UI title', async () => {
  const s = await setup()
  await s.rename('Tom sync')
  await s.rename('Tom 1:1')
  await expect(s.service.api.queue({ sessionPath: s.file, title: 'Tom sync' })).rejects.toThrow(
    refusal,
  )
  expect(s.runner).not.toHaveBeenCalled()
})
it('refuses Read again after the lane is renamed to a never-read title', async () => {
  const s = await setup()
  await s.rename('Tom sync')
  const old = (await s.service.api.queue({ sessionPath: s.file, title: 'Tom sync' })).jobs[0]!
  s.store.updateJob(old.id, { state: 'done' })
  await s.rename('Tom 1:1')
  await expect(s.service.api.reread(old.id)).rejects.toThrow(refusal)
  expect(s.runner).not.toHaveBeenCalled()
})
it.each([false, true])(
  'cancels a renamed lane at start (waiting: %s) before any call',
  async (busy) => {
    const s = await setup()
    vi.spyOn(s.options.lanes, 'busy').mockReturnValue(busy)
    await s.rename('Tom sync')
    const job = (await s.service.api.queue({ sessionPath: s.file, title: 'Tom sync' })).jobs[0]!
    expect(job.state).toBe(busy ? 'waiting' : 'queued')
    await s.rename('Tom 1:1')
    vi.spyOn(s.options.lanes, 'busy').mockReturnValue(false)
    vi.spyOn(s.options.embeddings, 'status').mockReturnValue({
      ...s.options.embeddings.status(),
      phase: 'ready',
    })
    await s.service.api.setPrefs(s.store.prefs)
    await vi.waitFor(() => expect(s.store.job(job.id)).toBeUndefined())
    expect(s.runner).not.toHaveBeenCalled()
    expect(s.options.log).toHaveBeenCalledWith(
      'Brain job cancelled',
      expect.objectContaining({ jobId: job.id, reason: refusal }),
    )
  },
)
