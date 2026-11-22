import { unlink } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OWNERSHIP_DETAIL,
  RINA_SUGGESTION,
  RINA_VIEW,
} from '../../../brain-client/src/__fixtures__/curator'
import { HARBOR_RECALL } from '../../../brain-client/src/__fixtures__/recall'
import { curatorFixture, nameLane, seedReview } from '../__fixtures__/curator'
import { BRAIN_OFF } from './curator-context'
import { READ_NOT_WAITING } from './review-refresh'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
const signal = new AbortController().signal
/** What a page of a read says when Brain never reads its lane. */
const NEVER_READ = 'Brain never reads this lane: reject it'
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

  it('readReview returns the current read as a page without the lane file, and refuses other reads', async () => {
    const s = await curatorSetup()
    const job = seedReview(s.store, 'ledger', s.lane)
    const { text } = await s.curator.readReview({ jobId: job.id }, signal)
    expect(text).toMatch(new RegExp(`^Read ${job.id} · ".+" · revision 0\\.`))
    expect(text).toContain('Decide with brain_decide_read')
    expect(text).toContain('- 0 · procedure · add · Rina approves Ledger invoices.')
    expect(text).not.toContain(s.lane)
    expect(s.queue.refreshInline).not.toHaveBeenCalled()
    s.store.prefs.neverRead = { ...s.store.prefs.neverRead, sessionIds: ['ledger'] }
    expect((await s.curator.readReview({ jobId: job.id }, signal)).text).toContain(NEVER_READ)
    s.store.updateJob(job.id, { state: 'done' })
    await expect(s.curator.readReview({ jobId: job.id }, signal)).rejects.toThrow(READ_NOT_WAITING)
    await expect(s.curator.readReview({ jobId: 'nope' }, signal)).rejects.toThrow(READ_NOT_WAITING)
  })

  it('marks a fresh read never read when its lane is renamed to a never-read title or deleted', async () => {
    const s = await curatorSetup()
    const job = seedReview(s.store, 'ledger', s.lane)
    const page = async () => (await s.curator.readReview({ jobId: job.id }, signal)).text
    await nameLane(s.lane, 'Harbor 1:1')
    const renamed = await page()
    expect(renamed).toContain(`Read ${job.id} · "Harbor 1:1" · revision 0.`)
    expect(renamed).toContain(NEVER_READ)
    await nameLane(s.lane, 'Harbor billing')
    expect(await page()).not.toContain(NEVER_READ)
    await unlink(s.lane)
    expect(await page()).toContain(NEVER_READ)
    expect(s.queue.refreshInline).not.toHaveBeenCalled()
  })

  it('a stale review of a never-read lane comes back stale, marked never read, unrefreshed', async () => {
    const s = await curatorSetup()
    const job = seedReview(s.store, 'ledger', s.lane)
    s.store.prefs.neverRead = { ...s.store.prefs.neverRead, sessionIds: ['ledger'] }
    s.store.rev++
    s.inRun('run-1')
    const { text } = await s.curator.readReview({ jobId: job.id }, signal)
    expect(text).toContain(' · revision 0.')
    expect(text).toContain(NEVER_READ)
    expect(s.queue.refreshInline).not.toHaveBeenCalled()
  })

  it('suggestion, entity and memory pass through without lane paths', async () => {
    const s = await curatorSetup()
    const detail = { ...OWNERSHIP_DETAIL, sourcePath: '/lanes/harbor.jsonl' }
    s.store.details.push(detail)
    expect((await s.curator.memory({ memoryId: 'ownership' }, signal)).sourcePath).toBeNull()
    s.store.agentSuggestion = () => ({
      ...RINA_SUGGESTION,
      subjects: [{ type: 'memory', value: detail }],
    })
    const suggestion = await s.curator.suggestion({ suggestionId: 'sugg' }, signal)
    expect(suggestion?.subjects[0]?.value).toMatchObject({ sourcePath: null })
    expect(detail.sourcePath).toBe('/lanes/harbor.jsonl')
    s.store.agentSuggestion = () => null
    expect(await s.curator.suggestion({ suggestionId: 'gone' }, signal)).toBeNull()
    await expect(s.curator.entity({ entityId: 'rina' }, signal)).rejects.toThrow('No entity')
  })

  it('scrubs every lane title it returns, as stored text is scrubbed', async () => {
    const s = await curatorSetup()
    const title = 'Harbor token=harbor-secret-123'
    const lane = (sessionId: string) => ({ sessionId, title })
    // The lane is named that now, and the read stored the same name.
    await nameLane(s.lane, title)
    const job = seedReview(s.store, 'ledger', s.lane)
    s.store.updateJob(job.id, { title })
    const memory = { ...OWNERSHIP_DETAIL.memory, origin: lane('harbor-lane') }
    const detail = {
      ...OWNERSHIP_DETAIL,
      memory,
      history: [memory],
      related: [{ kind: 'conflicts' as const, memory }],
    }
    s.store.details.push(detail)
    s.store.entity = () => ({ ...RINA_VIEW, sources: [{ ...lane('harbor-lane'), memories: 3 }] })
    s.store.agentSuggestion = () => ({
      ...RINA_SUGGESTION,
      suggestion: {
        ...RINA_SUGGESTION.suggestion,
        flag: { problem: 'outdated', ...lane('harbor-lane') },
      },
      subjects: [
        { type: 'entity', value: s.store.entity() },
        { type: 'memory', value: detail },
      ],
    })
    s.search.result = { ...HARBOR_RECALL, hits: [{ ...HARBOR_RECALL.hits[0]!, memory }] }
    const returned = JSON.stringify([
      await s.curator.waiting({}, signal),
      await s.curator.readReview({ jobId: job.id }, signal),
      await s.curator.suggestion({ suggestionId: 'sugg-rina' }, signal),
      await s.curator.entity({ entityId: 'rina' }, signal),
      await s.curator.memory({ memoryId: memory.id }, signal),
      await s.curator.search({ query: 'Harbor' }, signal),
    ])
    expect(returned).not.toContain('harbor-secret-123')
    expect(returned.split('Harbor [redacted]').length - 1).toBe(12)
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
