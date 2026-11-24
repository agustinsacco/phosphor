import { expect, it, vi } from 'vitest'
import { savedRead, realService } from '../tidy/__fixtures__/real-service'

/** Deterministic made-up embeddings: each text lands at its own angle. */
const embed = async (texts: string[]) =>
  texts.map((text) => {
    const vector = Array<number>(768).fill(0)
    const sum = [...text].reduce((total, c) => total + c.charCodeAt(0), 0)
    vector[0] = 1
    vector[1] = (sum % 97) / 97
    vector[2] = (text.length % 13) / 13
    return vector
  })

it.each(['Harbor', 'Ledger policy', 'Rina', 'weekly invoices'])(
  'brain:find returns the memories brain_search returns for "%s", in the same order',
  async (query) => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-11-01T12:00:00Z') })
    try {
      const s = await realService()
      s.options.embeddings.embed = embed
      await savedRead(s.store, s.service, s.options, [
        'Harbor keeps Ledger policy for refunds.',
        'Rina leads Ledger.',
        'Harbor bills weekly invoices.',
        'Rina reviews Harbor invoices on Fridays.',
        'Ledger policy changed in March.',
        'Tom Lee archives Harbor invoices.',
      ])
      for (const limit of [3, 8, 20]) {
        const agent = await s.service.agent('search', { query, limit })
        const found = await s.service.api.find(query, limit)
        if (agent.mode !== 'search') throw new Error('Expected query results')
        expect(agent.hits.length).toBeGreaterThan(1)
        expect(found.memories.map((m) => m.id)).toEqual(agent.hits.map((hit) => hit.memory.id))
      }
    } finally {
      vi.useRealTimers()
    }
  },
)
