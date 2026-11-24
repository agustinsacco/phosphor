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
  const service = await createBrainService(s.options)
  cleanups.push(() => service.dispose())
  return { ...s, service }
}
it.each(['Rina 1-1 prep', 'Harbor ONE ON ONE'])(
  'refuses Queue for a never-read title: %s',
  async (title) => {
    const s = await setup()
    await appendFile(s.file, '\n' + JSON.stringify({ type: 'session_info', name: title }))
    await expect(s.service.api.queue({ sessionPath: s.file, title })).rejects.toThrow(
      'Brain never reads this lane because its title matches a rule in Settings › Brain.',
    )
    expect(s.runner).not.toHaveBeenCalled()
  },
)
it('refuses Queue and Read again for an excluded lane without affecting a finished read', async () => {
  const s = await setup()
  const old = s.store.enqueue(
    {
      sessionId: 'harbor-lane',
      sessionPath: s.file,
      title: 'Harbor',
      scope: s.directory,
      branch: null,
      model: 'example/reader',
      leafId: 'old',
    },
    'queued',
  )
  s.store.updateJob(old.id, { state: 'done' })
  await s.service.api.neverRead('harbor-lane', true)
  await expect(s.service.api.queue({ sessionPath: s.file, title: 'Harbor' })).rejects.toThrow(
    'Brain is set not to read this lane.',
  )
  await expect(s.service.api.reread(old.id)).rejects.toThrow('Brain is set not to read this lane.')
  expect(s.runner).not.toHaveBeenCalled()
})
it('cancels waiting and queued jobs when an id or title becomes excluded, but preserves finished reads', async () => {
  const s = await setup()
  vi.spyOn(s.options.embeddings, 'status').mockReturnValue({
    ...s.options.embeddings.status(),
    phase: 'missing',
  })
  const first = await s.service.api.queue({ sessionPath: s.file, title: 'Harbor' })
  const job = first.jobs[0]!
  await s.service.api.neverRead(job.sessionId, true)
  expect(s.store.job(job.id)).toBeUndefined()
  await s.service.api.neverRead(job.sessionId, false)
  vi.spyOn(s.options.lanes, 'busy').mockReturnValue(true)
  const waiting = (await s.service.api.queue({ sessionPath: s.file, title: 'Ledger' })).jobs[0]!
  expect(waiting.state).toBe('waiting')
  await appendFile(s.file, '\n' + JSON.stringify({ type: 'session_info', name: 'Ledger' }))
  await s.service.api.setPrefs({
    ...s.store.prefs,
    neverRead: { ...s.store.prefs.neverRead, titles: ['Ledger'] },
  })
  await vi.waitFor(() => expect(s.store.job(waiting.id)).toBeUndefined())
  s.store.jobs.push({ ...waiting, id: 'pending', state: 'done' })
  await s.service.api.neverRead(waiting.sessionId, true)
  expect(s.store.job('pending')?.state).toBe('done')
  expect(s.runner).not.toHaveBeenCalled()
})
