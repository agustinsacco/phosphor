import { describe, expect, it } from 'vitest'
import type { BrainProposalView } from '@phosphor/shared/brain-review'
import { LEDGER_REVIEW } from '../../../brain-client/src/__fixtures__/curator'
import { readDecision } from './read-decision'

const ledger = LEDGER_REVIEW.proposal
const answered = { ref: 'e1', answer: 'rina' }

/** The ledger read with `count` required identities, each named by one memory. */
function manyRequired(count: number): BrainProposalView {
  const identity = ledger.identities[0]!
  const memory = ledger.memories[0]!
  return {
    ...ledger,
    identities: Array.from({ length: count }, (_, i) => ({ ...identity, ref: `n${i + 1}` })),
    memories: Array.from({ length: count }, (_, i) => ({
      ...memory,
      index: i,
      entities: [`n${i + 1}`],
    })),
  }
}

describe('readDecision', () => {
  it('saves every memory that is not held by default', () => {
    const held = { ...ledger.memories[0]!, index: 1, hold: 'temporary' as const }
    const p = { ...ledger, memories: [...ledger.memories, held] }
    expect(readDecision(p, { identities: [answered] })).toEqual({
      decision: {
        memories: [0],
        identities: { e1: 'rina' },
        groups: [],
        descriptions: [],
        confirmations: [],
      },
    })
  })

  it('names an unanswered required identity a chosen memory names, and saves nothing', () => {
    expect(readDecision(ledger, {})).toEqual({
      problem:
        'Not approved: answer e1 first, in identities ({ ref, answer: an entity id or "new" }). Open brain_read_review for their candidates.',
    })
  })

  it('needs no answer when no chosen memory names the required identity', () => {
    const p = {
      ...ledger,
      memories: ledger.memories.map((m) => ({ ...m, entities: ['e2'] })),
    }
    expect(readDecision(p, { memories: [0], groups: [] })).toMatchObject({
      decision: { memories: [0], identities: {} },
    })
    expect(readDecision(ledger, { memories: [] })).toMatchObject({ decision: { memories: [] } })
  })

  it('lists ten refs, then how many more, within what the tool shows of a write message', () => {
    const result = readDecision(manyRequired(300), {}) as { problem: string }
    expect(result.problem).toContain(
      'answer n1, n2, n3, n4, n5, n6, n7, n8, n9, n10 and 290 more first',
    )
    expect(result.problem.length).toBeLessThanOrEqual(400)
    const long = manyRequired(12)
    long.identities = long.identities.map((i) => ({ ...i, ref: `${i.ref}${'x'.repeat(60)}` }))
    long.memories = long.memories.map((m) => ({
      ...m,
      entities: [`${m.entities[0]}${'x'.repeat(60)}`],
    }))
    expect((readDecision(long, {}) as { problem: string }).problem.length).toBeLessThanOrEqual(400)
  })

  it('refuses choices the shared decision rules refuse', () => {
    expect(readDecision(ledger, { memories: [0, 0], identities: [answered] })).toEqual({
      problem: 'Invalid review selection.',
    })
    expect(readDecision(ledger, { identities: [answered], confirmations: [0, 0] })).toEqual({
      problem: 'Brain confirmation choice is invalid.',
    })
  })
})
