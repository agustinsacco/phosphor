import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrainMemoryDetail } from '@phosphor/shared/brain'
import type { BrainTidySuggestionDetail } from '@phosphor/shared/brain-tidy'
import { curatorFixture, seedReview } from '../__fixtures__/curator'
import { BRAIN_OFF } from './curator-context'
import { READ_NOT_WAITING } from './review-refresh'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
const signal = new AbortController().signal
async function curatorSetup() {
  const s = await curatorFixture()
  cleanups.push(s.cleanup)
  return s
}

describe('curator reads', () => {
  it('waiting lists reads oldest first, then suggestions, within the limit', async () => {
    const s = await curatorSetup()
    seedReview(s.store, 'ledger', s.lane, 20)
    seedReview(s.store, 'harbor 1:1', s.lane, 10)
    s.store.counts = { reads: 2, entities: 1, repeats: 0, conflicts: 0, flags: 0 }
    const suggestions = vi.spyOn(s.store, 'waitingSuggestions').mockReturnValue({
      items: [
        {
          kind: 'same_entity',
          suggestionId: 'sugg-rina',
          subjects: [],
          reason: 'Same name.',
          problem: null,
          createdAt: 1,
        },
      ],
      more: 4,
    })
    const result = await s.curator.waiting({}, signal)
    expect(result.counts).toEqual(s.store.counts)
    expect(result.items.map((item) => (item.kind === 'read' ? item.title : item.kind))).toEqual([
      'harbor 1:1',
      'ledger',
      'same_entity',
    ])
    expect(result.items[0]).toMatchObject({ memories: 1, questions: 1, neverRead: true })
    expect(result.items[1]).toMatchObject({ neverRead: false, state: 'review' })
    expect(suggestions).toHaveBeenCalledWith(58, 40)
    expect(result.more).toBe(4)
    await s.curator.waiting({ limit: 1 }, signal)
    expect(suggestions).toHaveBeenLastCalledWith(0, 40)
    expect((await s.curator.waiting({ limit: 1 }, signal)).more).toBe(5)
  })

  it('readReview returns the current proposal without the lane file, and refuses other reads', async () => {
    const s = await curatorSetup()
    const job = seedReview(s.store, 'ledger', s.lane)
    const review = await s.curator.readReview({ jobId: job.id }, signal)
    expect(review.neverRead).toBe(false)
    expect(review.proposal.job).toMatchObject({ id: job.id, sessionPath: '' })
    expect(review.proposal.memories).toHaveLength(1)
    expect(s.queue.refreshInline).not.toHaveBeenCalled()
    s.store.prefs.neverRead = { ...s.store.prefs.neverRead, sessionIds: ['ledger'] }
    expect((await s.curator.readReview({ jobId: job.id }, signal)).neverRead).toBe(true)
    s.store.updateJob(job.id, { state: 'done' })
    await expect(s.curator.readReview({ jobId: job.id }, signal)).rejects.toThrow(READ_NOT_WAITING)
    await expect(s.curator.readReview({ jobId: 'nope' }, signal)).rejects.toThrow(READ_NOT_WAITING)
  })

  it('a stale review of a never-read lane comes back stale, marked never read, unrefreshed', async () => {
    const s = await curatorSetup()
    const job = seedReview(s.store, 'ledger', s.lane)
    s.store.prefs.neverRead = { ...s.store.prefs.neverRead, sessionIds: ['ledger'] }
    s.store.rev++
    s.inRun('run-1')
    const review = await s.curator.readReview({ jobId: job.id }, signal)
    expect(review).toMatchObject({ neverRead: true, proposal: { revision: 0 } })
    expect(s.queue.refreshInline).not.toHaveBeenCalled()
  })

  it('suggestion, entity and memory pass through without lane paths', async () => {
    const s = await curatorSetup()
    const detail = { memory: { id: 'ownership' }, sourcePath: '/lanes/harbor.jsonl' }
    s.store.details.push(detail as unknown as BrainMemoryDetail)
    expect((await s.curator.memory({ memoryId: 'ownership' }, signal)).sourcePath).toBeNull()
    s.store.agentSuggestion = () =>
      ({
        suggestion: { id: 'sugg' },
        subjects: [{ type: 'memory', value: detail }],
        allowed: ['keep'],
      }) as unknown as BrainTidySuggestionDetail
    const suggestion = await s.curator.suggestion({ suggestionId: 'sugg' }, signal)
    expect(suggestion?.subjects[0]?.value).toMatchObject({ sourcePath: null })
    expect(detail.sourcePath).toBe('/lanes/harbor.jsonl')
    s.store.agentSuggestion = () => null
    expect(await s.curator.suggestion({ suggestionId: 'gone' }, signal)).toBeNull()
    await expect(s.curator.entity({ entityId: 'rina' }, signal)).rejects.toThrow('No entity')
  })

  it('search ranks no lane project first', async () => {
    const s = await curatorSetup()
    await s.curator.search({ query: 'Harbor', cwd: '/projects/harbor', limit: 3 }, signal)
    expect(s.search.searches[0]).toMatchObject({
      query: 'Harbor',
      scope: null,
      branch: null,
      limit: 3,
    })
    expect(s.search.searches[0]!.vector).toBeInstanceOf(Float32Array)
  })

  it('works with lane recall off, and refuses every read when Brain is off', async () => {
    const s = await curatorSetup()
    s.store.prefs.recall = false
    await expect(s.curator.waiting({}, signal)).resolves.toMatchObject({ items: [] })
    s.store.prefs.enabled = false
    for (const read of [
      () => s.curator.waiting({}, signal),
      () => s.curator.readReview({ jobId: 'job' }, signal),
      () => s.curator.suggestion({ suggestionId: 's' }, signal),
      () => s.curator.entity({ entityId: 'e' }, signal),
      () => s.curator.memory({ memoryId: 'm' }, signal),
      () => s.curator.search({ query: 'Harbor' }, signal),
    ])
      await expect(read()).rejects.toThrow(BRAIN_OFF)
  })
})
