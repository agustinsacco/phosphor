import { describe, expect, it } from 'vitest'
import { BRAIN_ERASE_LIMIT, BRAIN_ERASE_LIMIT_REFUSAL } from '@phosphor/shared/brain-agent'
import { createBrainCuratorClient } from '@phosphor/brain-client/curator-client'
import { createNodeBrainTransport } from '@phosphor/brain-client/node-transport'
import type { BrainService } from '../types'
import { savedRead, realService } from '../tidy/__fixtures__/real-service'

const CURATOR = { extension: '/made-up/brain-curator.mjs', skill: '/made-up/brain-agent' }

/** Brain Agent's own client, over the bridge with the curator token, as the extension builds it. */
async function curatorClient(service: BrainService) {
  const launch = await service.curatorLaunch()
  expect(launch?.extensions).toEqual([CURATOR.extension])
  return createBrainCuratorClient(
    createNodeBrainTransport(launch!.connection, { timeoutMs: 60_000 }),
  )
}

describe('Brain Agent against the real engine', { timeout: 60_000 }, () => {
  it('erases with its own reason, refuses a quoting one, and stops at the hourly cap', async () => {
    const { store, service, options } = await realService({ curator: CURATOR })
    const summaries = Array.from(
      { length: BRAIN_ERASE_LIMIT + 1 },
      (_, i) => `Service number ${i} answers on port ${8000 + i}.`,
    )
    await savedRead(store, service, options, summaries)
    const memories = store
      .laneMemories('harbor-read')
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
    await savedRead(store, service, options)
    const client = await curatorClient(service)
    const waiting = await client.call('waiting', { limit: 200 })
    const repeat = waiting.items.find((item) => item.kind === 'same_memory')
    expect(repeat).toBeDefined()
    const id = repeat!.suggestionId
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
    expect(after.items.some((item) => item.suggestionId === id)).toBe(false)
    const undone = await client.call('undo', {
      operationId: folded.operationId!,
      reason: 'They differ after all.',
    })
    expect(undone.status).toBe('done')
  })
})
