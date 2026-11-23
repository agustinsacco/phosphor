import { describe, expect, it } from 'vitest'
import { BRAIN_ERASE_LIMIT, BRAIN_ERASE_LIMIT_REFUSAL } from '@phosphor/shared/brain-agent'
import { createBrainCuratorClient } from '@phosphor/brain-client/curator-client'
import { createNodeBrainTransport } from '@phosphor/brain-client/node-transport'
import type { BrainService } from '../types'
import { approveRead, proposeRead, realService } from '../tidy/__fixtures__/real-service'

const CURATOR = { extension: '/made-up/brain-curator.mjs', skill: '/made-up/brain-agent' }
const KEEP_ALL = { identities: {}, groups: [], descriptions: [], confirmations: [] }

/** Brain Agent's own client, over the bridge with the curator token, as the extension builds it. */
async function curatorClient(service: BrainService) {
  const launch = await service.curatorLaunch()
  expect(launch?.extensions).toEqual([CURATOR.extension])
  return createBrainCuratorClient(
    createNodeBrainTransport(launch!.connection, { timeoutMs: 60_000 }),
  )
}

/** The first page of a read, and the revision it tells Brain Agent to decide on. */
async function openRead(client: Awaited<ReturnType<typeof curatorClient>>, jobId: string) {
  const { text } = await client.call('readReview', { jobId })
  return { text, revision: Number(/ · revision (\d+)\./.exec(text)![1]) }
}

describe('Brain Agent against the real engine', { timeout: 60_000 }, () => {
  it('decides a read strictly on its revision, and rejects whatever the revision', async () => {
    const { store, service, options } = await realService({ curator: CURATOR })
    const job = await proposeRead(store, options, ['Ledger bills monthly.'])
    const client = await curatorClient(service)
    const waiting = await client.call('waiting', {})
    expect(waiting.items).toContainEqual(expect.objectContaining({ kind: 'read', jobId: job.id }))
    const { text, revision } = await openRead(client, job.id)
    expect(text).toContain('- 0 · fact · add · Ledger bills monthly.')
    expect(text).not.toContain(job.sessionPath)
    const stale = await client.call('decideRead', {
      jobId: job.id,
      revision: revision + 1,
      approve: true,
      memories: [0],
      reason: 'Durable billing fact.',
    })
    expect(stale.status).toBe('changed')
    expect(store.job(job.id)!.state).toBe('review')
    const rejected = await client.call('decideRead', {
      jobId: job.id,
      revision: revision + 7,
      approve: false,
      reason: 'Nothing a future lane would act on.',
    })
    expect(rejected.status).toBe('done')
    expect(store.job(job.id)!.state).not.toBe('review')
  })

  it('approves at the current revision, then undoes the approval', async () => {
    const { store, service, options } = await realService({ curator: CURATOR })
    const job = await proposeRead(store, options, ['Ledger bills monthly.'])
    const client = await curatorClient(service)
    const { revision } = await openRead(client, job.id)
    const approved = await client.call('decideRead', {
      jobId: job.id,
      revision,
      approve: true,
      reason: 'Durable billing fact.',
    })
    expect(approved).toMatchObject({ status: 'done', operationId: expect.any(String) })
    const [saved] = store.laneMemories(job.sessionId).ids
    expect(store.memory(saved!).memory.summary).toBe('Ledger bills monthly.')
    const undone = await client.call('undo', {
      operationId: approved.operationId!,
      reason: 'Approved the wrong read.',
    })
    expect(undone.status).toBe('done')
  })

  it('erases with its own reason, refuses a quoting one, and stops at the hourly cap', async () => {
    const { store, service, options } = await realService({ curator: CURATOR })
    const summaries = Array.from(
      { length: BRAIN_ERASE_LIMIT + 1 },
      (_, i) => `Service number ${i} answers on port ${8000 + i}.`,
    )
    const job = await proposeRead(store, options, summaries)
    store.review(
      job.id,
      { memories: summaries.map((_, i) => i), ...KEEP_ALL },
      store.knowledgeRevision(),
    )
    const memories = store
      .laneMemories(job.sessionId)
      .ids.map((id) => ({ id, summary: store.memory(id).memory.summary }))
    expect(memories).toHaveLength(BRAIN_ERASE_LIMIT + 1)
    const client = await curatorClient(service)
    const quoting = await client.call('erase', {
      memoryId: memories[0]!.id,
      reason: memories[0]!.summary,
    })
    expect(quoting).toEqual({
      status: 'refused',
      message: 'Give a reason without quoting the memory; nothing changed.',
      operationId: null,
    })
    for (const memory of memories.slice(0, BRAIN_ERASE_LIMIT)) {
      const erased = await client.call('erase', {
        memoryId: memory.id,
        reason: 'Superseded by the service catalogue.',
      })
      expect(erased).toEqual({
        status: 'done',
        message: 'Erased. This is final: only your reason is kept.',
        operationId: null,
      })
    }
    const capped = await client.call('erase', {
      memoryId: memories[BRAIN_ERASE_LIMIT]!.id,
      reason: 'Superseded by the service catalogue.',
    })
    expect(capped).toEqual({
      status: 'limit',
      message: BRAIN_ERASE_LIMIT_REFUSAL,
      operationId: null,
    })
    expect(store.memory(memories[BRAIN_ERASE_LIMIT]!.id).memory.id).toBe(
      memories[BRAIN_ERASE_LIMIT]!.id,
    )
  })

  it('resolves a repeat the local pass found, and undoes it', async () => {
    const { store, service, options } = await realService({ curator: CURATOR })
    await approveRead(store, service, options)
    const client = await curatorClient(service)
    const waiting = await client.call('waiting', { limit: 200 })
    const repeat = waiting.items.find((item) => item.kind === 'same_memory')
    expect(repeat).toBeDefined()
    const id = repeat!.kind === 'read' ? '' : repeat!.suggestionId
    const detail = await client.call('suggestion', { suggestionId: id })
    expect(detail?.allowed).toContain('fold')
    const survivor = detail!.subjects[0]!.value as { memory: { id: string } }
    const folded = await client.call('resolve', {
      suggestionId: id,
      action: { kind: 'fold', survivorId: survivor.memory.id },
      reason: 'Both say Rina leads Ledger.',
    })
    expect(folded).toMatchObject({ status: 'done', operationId: expect.any(String) })
    const after = await client.call('waiting', { limit: 200 })
    expect(after.items.some((item) => item.kind !== 'read' && item.suggestionId === id)).toBe(false)
    const undone = await client.call('undo', {
      operationId: folded.operationId!,
      reason: 'They differ after all.',
    })
    expect(undone.status).toBe('done')
  })
})
