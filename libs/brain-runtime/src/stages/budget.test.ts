import { expect, it } from 'vitest'
import { applyClaimBudget } from './budget'
import type { FoldedJob } from './fold'

it('holds claims above 300 explicitly, prioritizing structural links then decisions, risks and opens', () => {
  const claims: FoldedJob['claims'] = Array.from({ length: 303 }, (_, i) => ({
    ref: `c${i}`,
    memory: {
      summary: `Harbor fact ${i}`,
      type: 'fact' as const,
      kind: 'reported' as const,
      entities: ['harbor'],
      links: [],
      branch: false,
      validFrom: null,
      validTo: null,
      citations: [],
      action: 'add' as const,
      target: null,
      reason: '',
    },
  }))
  const job: FoldedJob = { entities: [], claims, parents: [], evidence: [], outcomes: [] }
  job.claims[302]!.memory.links = [
    {
      subject: 'harbor',
      predicate: 'part_of',
      object: 'kestrel',
      citation: { evidence: 0, quote: 'Harbor is part of Kestrel' },
    },
  ]
  job.claims[301]!.memory.type = 'risk'
  expect(applyClaimBudget(job)).toBe(3)
  expect(job.claims).toHaveLength(300)
  expect(job.claims.some((c) => c.ref === 'c302')).toBe(true)
  expect(job.claims.some((c) => c.ref === 'c301')).toBe(true)
  expect(job.outcomes.filter((o) => o.status === 'held')).toHaveLength(3)
})
