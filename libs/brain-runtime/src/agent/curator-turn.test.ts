import { afterEach, describe, expect, it } from 'vitest'
import { curatorFixture } from '../__fixtures__/curator'
import type { BrainAgentHost, BrainAgentTurnGate } from '../types'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
const signal = new AbortController().signal
const reason = 'Both records name the same Slack user.'
const relate = {
  subjectId: 'rina',
  objectId: 'harbor',
  predicate: 'owns' as const,
  label: 'owns',
  memoryIds: ['ownership'],
  reason,
}
const correct = {
  memoryId: 'ownership',
  summary: 'Tom Lee owns Harbor billing.',
  source: 'Linear KES-12',
  quote: 'Tom takes over.',
  reason,
}

/** A Host lane whose running turn is `current`: null when no turn of known identity runs. */
async function hostLane() {
  const s = await curatorFixture()
  cleanups.push(s.cleanup)
  let current: BrainAgentTurnGate | null = null
  const agent = {
    folder: '/unused',
    turn: async () => {
      throw new Error('unused')
    },
    tell: async () => {
      throw new Error('unused')
    },
    turnGate: () => current,
  } satisfies BrainAgentHost
  s.options.agent = agent
  return {
    ...s,
    run: (gate: BrainAgentTurnGate | null) => {
      current = gate
    },
  }
}

const controller = (admit: () => boolean): BrainAgentTurnGate => ({ kind: 'controller', admit })

describe('Brain Agent’s curator on a Host lane', () => {
  it('refuses every read and write when no turn of known identity runs', async () => {
    const s = await hostLane()
    await expect(s.curator.waiting({ limit: 5 }, signal)).rejects.toThrow()
    await expect(s.curator.entity({ entityId: 'rina' }, signal)).rejects.toThrow()
    expect((await s.curator.relate(relate, signal)).status).toBe('refused')
    expect(s.store.calls).toEqual([])
  })

  it('writes for a controller turn only while its initiator keeps authority', async () => {
    const s = await hostLane()
    let allowed = true
    s.run(controller(() => allowed))
    expect((await s.curator.relate(relate, signal)).status).toBe('done')
    // A controller's turn is never attributed to a Defrag run, even one that is answering.
    s.inRun('run-7')
    expect((await s.curator.relate(relate, signal)).status).toBe('done')
    expect(s.store.calls.map((call) => call.note)).toEqual([
      { runId: null, reason },
      { runId: null, reason },
    ])
    allowed = false
    expect((await s.curator.relate(relate, signal)).status).toBe('refused')
    await expect(s.curator.memory({ memoryId: 'ownership' }, signal)).rejects.toThrow()
    expect(s.store.calls).toHaveLength(2)
  })

  it('rechecks at the write itself, after the call’s awaits', async () => {
    const s = await hostLane()
    let allowed = true
    s.run(controller(() => allowed))
    s.options.embeddings.embed = async () => {
      allowed = false
      return [[0.1, 0.2]]
    }
    expect((await s.curator.correct(correct, signal)).status).toBe('refused')
    expect(s.store.calls).toEqual([])
  })

  it('never lets a late call borrow a later turn’s authority', async () => {
    const s = await hostLane()
    const first = { live: true }
    s.run(controller(() => first.live))
    s.options.embeddings.embed = async () => {
      // The first turn ends and the next one (another controller, or Defrag) starts.
      first.live = false
      s.run(controller(() => true))
      s.inRun('run-8')
      return [[0.1, 0.2]]
    }
    expect((await s.curator.correct(correct, signal)).status).toBe('refused')
    expect(s.store.calls).toEqual([])
  })

  it('attributes a Defrag turn to the run it started with, and refuses once that run changes', async () => {
    const s = await hostLane()
    s.run({ kind: 'defrag', admit: () => true })
    // Defrag's identity with no run answering is no authority at all.
    expect((await s.curator.relate(relate, signal)).status).toBe('refused')
    s.inRun('run-9')
    expect((await s.curator.relate(relate, signal)).status).toBe('done')
    expect(s.store.calls[0]?.note).toEqual({ runId: 'run-9', reason })
    s.options.embeddings.embed = async () => {
      s.inRun('run-10')
      return [[0.1, 0.2]]
    }
    expect((await s.curator.correct(correct, signal)).status).toBe('refused')
    expect(s.store.calls).toHaveLength(1)
  })
})
