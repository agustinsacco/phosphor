import { expect, expectTypeOf, it } from 'vitest'
import {
  BRAIN_EMBEDDING_MODEL,
  BRAIN_ENTITY_KINDS,
  BRAIN_MEMORY_TYPES,
  BRAIN_PREDICATES,
  BRAIN_PROTOCOL,
  DEFAULT_BRAIN_PREFS,
  type BrainAgentMethod,
} from './brain'
import {
  BRAIN_CURATOR_METHODS,
  BRAIN_LANE_METHODS,
  type BrainAgentMap,
  type BrainAgentWrite,
} from './brain-agent'

it('starts off, with recall and review on for when it is enabled', () => {
  expect(DEFAULT_BRAIN_PREFS).toEqual({
    enabled: false,
    recall: true,
    review: true,
    model: null,
    neverRead: { titles: ['1:1', '1-1', 'one on one', '1on1'], sessionIds: [] },
  })
})

it('gives lane agents search and flags; only the Brain lane decides, edits and erases', () => {
  expect(BRAIN_PROTOCOL).toBe(6)
  expect(BRAIN_LANE_METHODS).toEqual(['search', 'flag'])
  expect([...BRAIN_CURATOR_METHODS].sort()).toEqual(
    [
      'correct',
      'decideRead',
      'edit',
      'entity',
      'erase',
      'memory',
      'readReview',
      'resolve',
      'search',
      'suggestion',
      'undo',
      'waiting',
    ].sort(),
  )
  expect(BRAIN_CURATOR_METHODS).not.toContain('flag')
  expectTypeOf<BrainAgentMethod>().toEqualTypeOf<
    | 'search'
    | 'flag'
    | 'waiting'
    | 'readReview'
    | 'suggestion'
    | 'entity'
    | 'memory'
    | 'decideRead'
    | 'resolve'
    | 'edit'
    | 'correct'
    | 'erase'
    | 'undo'
  >()
})

it('pages a read and takes Brain Agent’s own decision, so no answer carries a whole read', () => {
  expectTypeOf<BrainAgentMap['readReview']>().toEqualTypeOf<{
    request: { jobId: string; offset?: number }
    result: { text: string }
  }>()
  expectTypeOf<BrainAgentMap['decideRead']>().toEqualTypeOf<{
    request: {
      jobId: string
      revision: number
      approve: boolean
      memories?: number[]
      identities?: { ref: string; answer: string }[]
      groups?: number[]
      descriptions?: string[]
      confirmations?: number[]
      reason: string
    }
    result: BrainAgentWrite
  }>()
})

it('pins the graph schema the extractor, engine and UI share', () => {
  expect(BRAIN_ENTITY_KINDS).toEqual([
    'person',
    'team',
    'organization',
    'project',
    'component',
    'document',
    'concept',
    'event',
  ])
  expect(BRAIN_PREDICATES).toEqual([
    'owns',
    'works_on',
    'member_of',
    'part_of',
    'for_customer',
    'documents',
    'depends_on',
    'uses',
    'decided',
    'prefers',
    'leads',
  ])
  expect(BRAIN_MEMORY_TYPES).toEqual([
    'decision',
    'open',
    'risk',
    'procedure',
    'preference',
    'fact',
  ])
})

it('identifies the measured local candidate and its separate use terms', () => {
  expect(BRAIN_EMBEDDING_MODEL.id).toBe(
    'embeddinggemma-300m-q4@5090578d9565bb06545b4552f76e6bc2c93e4a66',
  )
  expect(BRAIN_EMBEDDING_MODEL.downloadBytes).toBe(218_726_989)
  expect(BRAIN_EMBEDDING_MODEL.dimensions).toBe(768)
  expect(BRAIN_EMBEDDING_MODEL.termsUrl).toBe('https://ai.google.dev/gemma/terms')
  expect(BRAIN_EMBEDDING_MODEL.usePolicyUrl).toBe(
    'https://ai.google.dev/gemma/prohibited_use_policy',
  )
})

import * as brain from './brain'
it('has only lasting entity kinds and typed rules for every link', () => {
  expect(brain.BRAIN_ENTITY_KINDS).not.toContain('ticket')
  for (const removed of ['blocks', 'affects', 'related_to'])
    expect(brain.BRAIN_PREDICATES).not.toContain(removed)
  expect(brain).toHaveProperty('BRAIN_LINK_RULES')
  const rules = Reflect.get(brain, 'BRAIN_LINK_RULES') as Record<
    string,
    { subject: string[]; object: string[] }
  >
  expect(Object.keys(rules)).toEqual([...brain.BRAIN_PREDICATES])
  for (const rule of Object.values(rules)) {
    expect(rule.subject.length).toBeGreaterThan(0)
    expect(rule.object.length).toBeGreaterThan(0)
    for (const kind of [...rule.subject, ...rule.object])
      expect(brain.BRAIN_ENTITY_KINDS).toContain(kind)
  }
})
