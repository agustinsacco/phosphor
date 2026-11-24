import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { openBrainStore } from '@phosphor/memory-engine/store'
import { openBrainSearch } from '@phosphor/memory-engine/search'
import { createBrainService } from './service'
import { pipelineSetup } from './__fixtures__/pipeline'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function setup() {
  const s = await pipelineSetup()
  cleanup.push(s.cleanup)
  const path = join(s.directory, 'brain.sqlite')
  const store = openBrainStore({ path, Database: DatabaseSync })
  store.setPrefs({
    neverRead: { titles: ['1:1', '1-1', 'one on one', '1on1'], sessionIds: [] },
    enabled: true,
    recall: true,
    agentAuto: true,
    model: null,
  })
  const service = await createBrainService({ ...s.options, openStore: () => store })
  cleanup.push(() => service.dispose())
  const search = openBrainSearch({ path, Database: DatabaseSync })
  cleanup.push(async () => search.close())
  const recall = () =>
    search
      .recall({
        query: 'Harbor',
        vector: null,
        scope: null,
        branch: null,
        limit: 20,
        now: Date.now(),
      })
      .hits.map((h) => h.memory.id)
  const queued = await service.api.queue({ sessionPath: s.file, title: 'Harbor' })
  const first = queued.jobs[0]!
  await vi.waitFor(() => expect(store.job(first.id)?.state).toBe('done'))
  first.leafId = store.job(first.id)!.leafId
  return { ...s, store, service, first, recall, path }
}
it('keeps done prompts and old recall until replacement saves', async () => {
  const s = await setup()
  const before = await s.service.api.extraction(s.first.id)
  expect(before.prompts).toEqual(s.runner.mock.calls.map(([call]) => call.prompt))
  expect(before.job?.state).toBe('done')
  const oldIds = s.recall()
  expect(oldIds).toHaveLength(1)
  vi.spyOn(s.options.lanes, 'busy').mockReturnValue(true)
  const queued = await s.service.api.reread(s.first.id)
  const next = queued.jobs[0]!
  expect(next).toMatchObject({ replaces: s.first.id, state: 'waiting' })
  expect(s.recall()).toEqual(oldIds)
  vi.mocked(s.options.lanes.busy).mockReturnValue(false)
  // Wakes the ordinary queue without changing its admission path.
  await s.service.api.setPrefs(s.store.snapshot().prefs)
  await vi.waitFor(() => expect(s.store.job(next.id)?.state).toBe('done'))
  expect(s.recall()).toHaveLength(1)
  expect(s.recall()).not.toEqual(oldIds)
  expect(s.store.job(s.first.id)?.state).toBe('done')
  expect((await s.service.api.laneRead(s.first.sessionId))?.job.id).toBe(next.id)
  const reconcilePrompts = s.runner.mock.calls
    .filter(([call]) => call.stage === 'reconcile')
    .map(([call]) => call.prompt)
    .join('\n')
  for (const id of oldIds) expect(reconcilePrompts).not.toContain(id)
  expect(
    (await s.service.api.extraction(next.id)).prompts.every(
      (p) => !p.startsWith('Prompt not available'),
    ),
  ).toBe(true)
})
it('keeps a saved reread finished when the search refresh fails afterwards', async () => {
  const s = await setup()
  s.store.setPrefs({
    neverRead: { titles: ['1:1', '1-1', 'one on one', '1on1'], sessionIds: [] },
    enabled: true,
    recall: true,
    agentAuto: false,
    model: null,
  })
  const oldIds = s.recall()
  vi.spyOn(s.search, 'refresh').mockRejectedValue(new Error('search worker exited'))
  const queued = await s.service.api.reread(s.first.id)
  const next = queued.jobs[0]!
  await vi.waitFor(() => expect(['done', 'failed']).toContain(s.store.job(next.id)?.state))
  // The replacement is already saved, so the read is finished, not a failure to retry.
  expect(s.store.job(next.id)).toMatchObject({ state: 'done', error: null })
  expect((await s.service.api.laneRead(s.first.sessionId))?.job.id).toBe(next.id)
  expect(s.recall()).toHaveLength(1)
  expect(s.recall()).not.toEqual(oldIds)
})

it('queues only new messages with two context-only segments and the lane memories already kept', async () => {
  const s = await setup()
  const { appendFile } = await import('node:fs/promises')
  await appendFile(
    s.file,
    '\n' +
      JSON.stringify({
        type: 'message',
        id: 'new-leaf',
        timestamp: '2026-11-08T12:00:00Z',
        message: { role: 'user', content: 'Harbor retains invoices for seven years.' },
      }),
  )
  s.runner.mockClear()
  await s.service.api.queue({ sessionPath: s.file, title: 'Harbor' })
  await vi.waitFor(() => expect(s.store.snapshot().jobs.at(-1)?.state).toBe('empty'))
  const job = s.store.snapshot().jobs.at(-1)!
  expect(job.fromLeafId).toBe(s.first.leafId)
  const read = s.runner.mock.calls.find(([call]) => call.stage === 'extract')![0]
  expect(read.prompt).toContain('[s1] context')
  expect(read.prompt).toContain('[s2] context')
  expect(read.prompt).toContain('[s3] user')
  expect(read.prompt).toContain('Already kept from earlier parts')
  expect(read.prompt).toContain('- Rina Okafor owns Harbor billing.')
  // The fixture reader repeats only the old claim; overlap may inform, never extract it anew.
  const record = await s.service.api.extraction(job.id)
  expect(record.outcomes).toContainEqual(
    expect.objectContaining({
      status: 'dropped',
      reason: 'Claim supported only by previously read context',
    }),
  )
  expect(record.prompts).toEqual(s.runner.mock.calls.map(([call]) => call.prompt))
})
