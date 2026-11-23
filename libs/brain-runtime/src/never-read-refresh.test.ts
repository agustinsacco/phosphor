import { decideRead } from './__fixtures__/decide-read'
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
  const status = await service.api.queue({ sessionPath: s.file, title: 'Tom sync' })
  const id = status.jobs[0]!.id
  await vi.waitFor(() => expect(s.store.job(id)?.state).toBe('review'))
  s.runner.mockClear()
  return { ...s, service, id }
}
const cannotRefresh =
  "Brain changed since this was read, and this lane is set to never be read, so it can't be refreshed. Reject it instead."

it.each(['id', 'title'] as const)(
  'does not background-refresh a stale never-read review (%s)',
  async (kind) => {
    const s = await setup()
    if (kind === 'title')
      await appendFile(s.file, '\n' + JSON.stringify({ type: 'session_info', name: 'Tom 1:1' }))
    else await s.service.api.neverRead('harbor-lane', true)
    const update = vi.spyOn(s.store, 'updateJob')
    s.store.rev++
    await s.service.api.setPrefs(s.store.prefs)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(s.store.job(s.id)?.state).toBe('review')
    expect(update.mock.calls.some(([, patch]) => patch.state === 'refreshing')).toBe(false)
    expect(s.runner).not.toHaveBeenCalled()
  },
)
it('rejects a stale review without starting a refresh or saving anything', async () => {
  const s = await setup()
  s.store.rev++
  await expect(decideRead(s.service, s.id, null, 0)).resolves.toMatchObject({ jobs: [] })
  expect(s.store.job(s.id)?.state).toBe('rejected')
  expect(s.store.reviews).toEqual([{ id: s.id, decision: null }])
  expect(s.runner).not.toHaveBeenCalled()
})
it.each(['id', 'title'] as const)(
  'refuses approval of a stale never-read review (%s) with a rejection remedy',
  async (kind) => {
    const s = await setup()
    if (kind === 'title')
      await appendFile(s.file, '\n' + JSON.stringify({ type: 'session_info', name: 'Tom 1:1' }))
    else await s.service.api.neverRead('harbor-lane', true)
    s.store.rev++
    await expect(
      decideRead(
        s.service,
        s.id,
        { memories: [0], identities: {}, groups: [], descriptions: [], confirmations: [] },
        0,
      ),
    ).rejects.toThrow(cannotRefresh)
    expect(s.store.job(s.id)?.state).toBe('review')
    expect(s.runner).not.toHaveBeenCalled()
  },
)

it('does not resurrect a review rejected while opening waits on the current lane file', async () => {
  const s = await setup()
  s.store.rev++
  const update = vi.spyOn(s.store, 'updateJob')
  const opening = s.service.api.proposal(s.id).catch((error: unknown) => error)
  await decideRead(s.service, s.id, null, 0)
  await opening
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(s.store.job(s.id)?.state).toBe('rejected')
  expect(update.mock.calls.some(([, patch]) => patch.state === 'refreshing')).toBe(false)
  expect(s.runner).not.toHaveBeenCalled()
})

it.each(['retry', 'queued upgrade'] as const)(
  'preserves a never-read proposal when its refresh is requeued through %s',
  async (mode) => {
    const s = await setup()
    if (mode === 'retry') s.store.updateJob(s.id, { state: 'failed' })
    await s.service.api.neverRead('harbor-lane', true)
    s.store.rev++
    if (mode === 'retry') await s.service.api.retry(s.id)
    else {
      s.store.updateJob(s.id, { state: 'queued' })
      await s.service.api.setPrefs(s.store.prefs)
    }
    await vi.waitFor(() => expect(s.store.job(s.id)?.state).toBe('review'))
    expect(s.store.storedProposal(s.id)).toBeDefined()
    expect(s.runner).not.toHaveBeenCalled()
    await expect(decideRead(s.service, s.id, null, 0)).resolves.toMatchObject({ jobs: [] })
    expect(s.store.job(s.id)?.state).toBe('rejected')
  },
)
