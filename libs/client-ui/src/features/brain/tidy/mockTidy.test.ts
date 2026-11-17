import { expect, it } from 'vitest'
import type {
  BrainTidyMutation,
  BrainTidyPage,
  BrainTidySuggestionDetail,
  BrainTidyChanges,
} from '@shared/brain-tidy'
import type { BrainStatus } from '@shared/brain'
import { createMockBrain } from '../mockBrain'

it('serves all kinds, recovers a first failed load, pages and advances a cancellable run', async () => {
  let now = 10000
  const call = createMockBrain(() => now, { count: 60, failFirstLoad: true, flagAfterMs: 9000 })
  await expect(call('brain:tidy', [null, null, 20])).rejects.toThrow('temporarily unavailable')
  const page = (await call('brain:tidy', [null, null, 20])) as BrainTidyPage
  expect(page.items).toHaveLength(20)
  expect(Object.values(page.counts)).toEqual([15, 15, 15, 15])
  expect(((await call('brain:tidy', [null, page.next, 20])) as BrainTidyPage).items[0]!.id).toBe(
    'tidy-20',
  )
  await call('brain:tidyRun', [])
  now += 3000
  expect(((await call('brain:tidy', [null, null, 20])) as BrainTidyPage).run?.state).toBe(
    'checking',
  )
  await call('brain:tidyCancel', [])
  expect(((await call('brain:tidy', [null, null, 20])) as BrainTidyPage).run?.state).toBe(
    'cancelled',
  )
  await call('brain:tidyRun', [])
  now += 10000
  const finished = (await call('brain:tidy', [null, null, 20])) as BrainTidyPage
  expect(finished.run?.state).toBe('done')
  expect(finished.coverage.phase).toBe('done')
  expect(finished.counts.flagged).toBe(16)
})

it('applies, dismisses, guards revisions and undoes through the same journal as manual merge', async () => {
  const call = createMockBrain(() => 10000)
  const page = (await call('brain:tidy', [null, null, 20])) as BrainTidyPage
  const detail = (await call('brain:tidySuggestion', [
    page.items[0]!.id,
  ])) as BrainTidySuggestionDetail
  expect(detail.subjects).toHaveLength(2)
  const mutation = (await call('brain:tidyApply', [
    detail.suggestion.id,
    { kind: 'merge', survivorId: detail.suggestion.subjects[0]!.id },
    0,
  ])) as BrainTidyMutation
  expect(mutation.operationId).toBeTruthy()
  await expect(call('brain:tidyUndo', [mutation.operationId, 0])).rejects.toThrow('Brain changed')
  const undone = (await call('brain:tidyUndo', [
    mutation.operationId,
    mutation.revision,
  ])) as BrainStatus
  expect(((await call('brain:tidyChanges', [20])) as BrainTidyChanges).items[0]!.undoneAt).toBe(
    10000,
  )
  await call('brain:tidyDismiss', [page.items[1]!.id, undone.revision])
  expect(((await call('brain:tidy', [null, null, 20])) as BrainTidyPage).items).toHaveLength(10)
  const status = (await call('brain:status', [])) as BrainStatus
  const merged = (await call('brain:merge', ['tom', 'rina', status.revision])) as BrainTidyMutation
  expect(merged.operationId).toBeTruthy()
})
