import { describe, expect, it } from 'vitest'
import type { BrainLearningEvidence } from '@phosphor/shared/brain-learning'
import { resolveLearningOutcome } from './brain-learning-result'

const evidence: BrainLearningEvidence[] = [
  {
    entryId: 'source',
    parentId: null,
    entryHash: 'entry',
    rootId: 'root',
    projectedHash: 'projection',
    evidenceId: 'evidence',
    role: 'user',
    text: 'Atlas depends on Mercury.',
    sourceType: 'message',
    eligible: true,
  },
]
const finding = () => ({
  subject: { label: 'Atlas', kind: 'component' },
  predicate: 'depends_on',
  object: { label: 'Mercury', kind: 'component' },
  summary: 'Atlas depends on Mercury.',
  kind: 'reported',
  citations: [{ role: 'user', quote: 'Atlas depends on Mercury.' }],
  validFrom: null,
  validTo: null,
})
const resolve = (value: unknown) =>
  resolveLearningOutcome(JSON.stringify({ type: 'findings', findings: [value] }), evidence)

describe('structured learning findings', () => {
  it('retains semantic entities and relations for deterministic graph proposals', () => {
    const input = finding()
    expect(resolve(input)).toEqual({
      type: 'findings',
      findings: [
        {
          ...input,
          citations: [{ evidenceId: 'evidence', quote: input.summary }],
        },
      ],
    })
  })
  it('supports a literal object and explicit temporal bounds', () => {
    const { object: _object, ...input } = finding()
    expect(
      resolve({ ...input, predicate: 'decided', literal: 'Use Mercury', validFrom: 1, validTo: 2 }),
    ).toMatchObject({
      findings: [{ predicate: 'decided', literal: 'Use Mercury', validFrom: 1, validTo: 2 }],
    })
  })
  it.each([
    { subject: null },
    { subject: { label: '', kind: 'component' } },
    { subject: { label: 'Atlas', kind: 'unknown' } },
    { predicate: 'invented' },
    { object: { label: 'Mercury', kind: 'unknown' } },
    { object: undefined },
    { literal: 'Both object forms' },
    { validFrom: 'yesterday' },
    { validFrom: 2, validTo: 1 },
    { validTo: -1 },
  ])('rejects an invalid semantic structure: %j', (patch) => {
    expect(() => resolve({ ...finding(), ...patch })).toThrow()
  })
  it('does not invent semantic entities from a summary-only finding', () => {
    const { summary, kind, citations } = finding()
    expect(() => resolve({ summary, kind, citations })).toThrow()
  })
})
