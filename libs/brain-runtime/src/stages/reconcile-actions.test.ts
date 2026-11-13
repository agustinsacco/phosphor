import { expect, it } from 'vitest'
import { approve, extraction, fixture, vector } from '@phosphor/memory-engine/test-support'
import { FakeBrainSearch } from '../__fixtures__/fake-store'
import type { StageAsk } from '../stage-types'
import { reconcile } from './reconcile'
import type { FoldedJob } from './fold'

it.each([
  ['confirm', 'supersede'],
  ['enrich', 'conflict'],
  ['conflict', 'resolve_open'],
  ['supersede', 'enrich'],
  ['supersede', 'supersede'],
] as const)(
  'allows only the highest-priority action on one target: %s, %s',
  async (first, second) => {
    const { store } = fixture()
    const [target] = approve(store, {
      memories: [{ ...extraction('').memories[0]!, type: 'open' }],
      memoryVectors: [vector()],
    })
    const old = store.memory(target!).memory
    const base = extraction('').memories[0]!
    const claims = [first, second].map((action, i) => ({
      ref: `c${i + 1}`,
      memory: {
        ...base,
        summary: action === 'confirm' ? old.summary : `Claim ${i + 1}`,
        entities: old.entityIds,
        links: old.links.map((l) => ({
          subject: l.subjectId,
          predicate: l.predicate,
          object: l.objectId,
          citation: base.citations[0]!,
        })),
      },
    }))
    const job: FoldedJob = { entities: [], claims, parents: [], evidence: [], outcomes: [] }
    const ask: StageAsk = async (_s, _p, prompt, validate) => {
      const rows = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1)) as {
        claim: { ref: string }
      }[]
      return validate(
        JSON.stringify({
          decisions: rows.map((r) => ({
            ref: r.claim.ref,
            action: [first, second][Number(r.claim.ref.slice(1)) - 1],
            target: 'M1',
            reason: 'Supported change',
          })),
        }),
      )
    }
    const confirmations = await reconcile(
      job,
      [],
      store,
      new FakeBrainSearch(),
      [vector(), vector()],
      ask,
    )
    expect(job.claims.filter((c) => c.memory.target === target).length + confirmations.length).toBe(
      1,
    )
    const priority = (action: string) =>
      ['confirm', 'enrich', 'conflict', 'supersede'].indexOf(
        action === 'resolve_open' ? 'supersede' : action,
      )
    const winner = priority(first) >= priority(second) ? first : second
    expect(job.claims.find((c) => c.memory.target === target)?.memory.action).toBe(winner)
    if (first === 'confirm') {
      expect(confirmations).toEqual([])
      expect(job.outcomes).toContainEqual(
        expect.objectContaining({
          candidate: 'c1',
          status: 'dropped',
          reason: expect.stringContaining('target'),
        }),
      )
    } else expect(job.claims.filter((c) => c.memory.action === 'add')).toHaveLength(1)
  },
)
