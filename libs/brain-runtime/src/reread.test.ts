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
  store.setPrefs({ enabled: true, recall: true, review: true })
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
  await service.api.review(
    first.id,
    { memories: [0], identities: {}, groups: [] },
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
    s.store.setPrefs({ enabled: true, recall: true, review })
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
      db.exec("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'")
      db.close()
      await expect(s.service.api.proposal(next.id)).rejects.toThrow('refreshing this review')
      await vi.waitFor(() => expect(s.store.job(next.id)?.state).toBe('review'))
      expect((await s.service.api.proposal(next.id)).replacingMemories).toBe(1)
      await s.service.api.review(
        next.id,
        { memories: [0], identities: {}, groups: [] },
        s.store.revision(),
      )
    }
    expect(s.recall()).toHaveLength(1)
    expect(s.recall()).not.toEqual(oldIds)
    expect(s.store.job(s.first.id)).toBeUndefined()
    expect(s.store.history(20).items.map((i) => i.job.id)).toEqual([next.id])
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
