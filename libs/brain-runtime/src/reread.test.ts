import { decideRead } from './__fixtures__/decide-read'
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
    review: true,
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
  await service.api.queue({ sessionPath: s.file, title: 'Harbor' })
  await vi.waitFor(() => expect(store.snapshot().jobs[0]?.state).toBe('review'))
  const first = store.snapshot().jobs[0]!
  await decideRead(
    service,
    first.id,
    { descriptions: [], confirmations: [], memories: [0], identities: {}, groups: [] },
    store.revision(),
  )
  return { ...s, store, service, first, recall, path }
}
it.each([true, false])(
  'keeps done prompts and old recall until replacement saves (review=%s)',
  async (review) => {
    const s = await setup()
    const before = await s.service.api.extraction(s.first.id)
    expect(before.prompts).toEqual(s.runner.mock.calls.map(([call]) => call.prompt))
    expect(before.job?.state).toBe('done')
    const oldIds = s.recall()
    expect(oldIds).toHaveLength(1)
    s.store.setPrefs({
      neverRead: { titles: ['1:1', '1-1', 'one on one', '1on1'], sessionIds: [] },
      enabled: true,
      recall: true,
      review,
      model: null,
    })
    vi.spyOn(s.options.lanes, 'busy').mockReturnValue(true)
    const queued = await s.service.api.reread(s.first.id)
    const next = queued.jobs[0]!
    expect(next).toMatchObject({ replaces: s.first.id, state: 'waiting' })
    expect(s.recall()).toEqual(oldIds)
    vi.mocked(s.options.lanes.busy).mockReturnValue(false)
    // Wakes the ordinary queue without changing its admission path.
    await s.service.api.setPrefs(s.store.snapshot().prefs)
    await vi.waitFor(() => expect(s.store.job(next.id)?.state).toBe(review ? 'review' : 'done'))
    if (review) {
      expect(s.recall()).toEqual(oldIds)
      const db = new DatabaseSync(s.path)
      db.exec(
        "UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key IN ('revision','knowledge_revision')",
      )
      db.close()
      // Brain Agent opens the stale review, which refreshes it.
      await s.service.agent('readReview', { jobId: next.id })
      expect(s.store.job(next.id)?.state).toBe('review')
      expect((await s.service.api.proposal(next.id)).replacingMemories).toBe(1)
      await decideRead(
        s.service,
        next.id,
        { descriptions: [], confirmations: [], memories: [0], identities: {}, groups: [] },
        s.store.revision(),
      )
    }
    expect(s.recall()).toHaveLength(1)
    expect(s.recall()).not.toEqual(oldIds)
    expect(s.store.job(s.first.id)?.state).toBe('done')
    expect(s.store.history(20).items.map((i) => i.job.id)).toEqual([next.id, s.first.id])
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
  },
)
it('keeps a saved reread finished when the search refresh fails afterwards', async () => {
  const s = await setup()
  s.store.setPrefs({
    neverRead: { titles: ['1:1', '1-1', 'one on one', '1on1'], sessionIds: [] },
    enabled: true,
    recall: true,
    review: false,
    model: null,
  })
  const oldIds = s.recall()
  vi.spyOn(s.search, 'refresh').mockRejectedValue(new Error('search worker exited'))
  const queued = await s.service.api.reread(s.first.id)
  const next = queued.jobs[0]!
  await vi.waitFor(() => expect(['done', 'failed']).toContain(s.store.job(next.id)?.state))
  // The replacement is already saved, so the read is finished, not a failure to retry.
  expect(s.store.job(next.id)).toMatchObject({ state: 'done', error: null })
  expect(s.store.history(20).items.map((i) => i.job.id)).toEqual([next.id, s.first.id])
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
  await vi.waitFor(() =>
    expect(['review', 'empty']).toContain(s.store.snapshot().jobs.at(-1)?.state),
  )
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
