import { appendFile, writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { createBrainService } from './service'
import { pipelineSetup } from './__fixtures__/pipeline'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
async function setup({ ready = true, busy = false } = {}) {
  const s = await pipelineSetup()
  cleanups.push(s.cleanup)
  s.store.jobs = []
  vi.spyOn(s.options.lanes, 'busy').mockReturnValue(busy)
  vi.spyOn(s.options.embeddings, 'status').mockReturnValue({
    ...s.options.embeddings.status(),
    phase: ready ? 'ready' : 'missing',
  })
  const service = await createBrainService(s.options)
  cleanups.push(() => service.dispose())
  const rename = (name: string) =>
    appendFile(s.file, '\n' + JSON.stringify({ type: 'session_info', name }))
  return { ...s, service, rename }
}
it('stores an untitled lane as an empty title, which no rule matches', async () => {
  const s = await setup({ ready: false })
  s.store.prefs.neverRead = { titles: ['lane'], sessionIds: [] }
  await writeFile(
    s.file,
    s.entries
      .slice(0, 2)
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  )
  const status = await s.service.api.queue({ sessionPath: s.file, title: 'Untitled lane' })
  expect(status.jobs.map((job) => [job.state, job.title])).toEqual([['queued', '']])
})

it('stores the current title when a read starts', async () => {
  const s = await setup({ busy: true })
  const id = (await s.service.api.queue({ sessionPath: s.file, title: 'Harbor' })).jobs[0]!.id
  await s.rename('Harbor sync')
  vi.mocked(s.options.lanes.busy).mockReturnValue(false)
  await s.service.api.setPrefs(s.store.prefs)
  await vi.waitFor(() => expect(s.store.job(id)?.state).toBe('done'))
  expect(s.store.job(id)?.title).toBe('Harbor sync')
  expect(s.store.saved.get(id)?.origin.title).toBe('Harbor sync')
})
