import { expect, expectTypeOf, it } from 'vitest'
import {
  BRAIN_EMBEDDING_MODEL,
  BRAIN_ENTITY_KINDS,
  BRAIN_MEMORY_TYPES,
  BRAIN_PREDICATES,
  BRAIN_PROTOCOL,
  BRAIN_TEMPORARY_DAYS,
  DEFAULT_BRAIN_PREFS,
  type BrainAgentMethod,
  type BrainJobState,
  type BrainMemory,
  type BrainPredicate,
  type BrainSnapshot,
} from './brain'
import {
  BRAIN_AUTO_RUNS_PER_DAY,
  BRAIN_CURATOR_METHODS,
  BRAIN_LANE_METHODS,
  BRAIN_RELATE_PER_RUN,
  type BrainAgentMap,
  type BrainAgentWrite,
  type BrainLinkInput,
  type BrainWaitingCounts,
} from './brain-agent'
import type { BrainQuery, BrainSearchResult } from './brain-recall'

it('starts off, with recall and Brain Agent’s automatic check on for when it is enabled', () => {
  expect(DEFAULT_BRAIN_PREFS).toEqual({
    enabled: false,
    recall: true,
    agentAuto: true,
    model: null,
    neverRead: { titles: ['1:1', '1-1', 'one on one', '1on1'], sessionIds: [] },
  })
  expect(BRAIN_TEMPORARY_DAYS).toBe(14)
  expect(BRAIN_RELATE_PER_RUN).toBe(60)
  expect(BRAIN_AUTO_RUNS_PER_DAY).toBe(6)
})

it('gives lane agents search and flags; only the Brain lane relates, edits and erases', () => {
  expect(BRAIN_PROTOCOL).toBe(7)
  expect(BRAIN_LANE_METHODS).toEqual(['search', 'flag'])
  expect([...BRAIN_CURATOR_METHODS].sort()).toEqual(
    [
      'correct',
      'edit',
      'entity',
      'erase',
      'memory',
      'relate',
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
    | 'suggestion'
    | 'entity'
    | 'memory'
    | 'resolve'
    | 'relate'
    | 'edit'
    | 'correct'
    | 'erase'
    | 'undo'
  >()
})

it('takes one of three search moves and answers with the matching result', () => {
  expectTypeOf<BrainAgentMap['search']>().toEqualTypeOf<{
    request: BrainQuery
    result: BrainSearchResult
  }>()
  expectTypeOf<BrainSearchResult['mode']>().toEqualTypeOf<'search' | 'expand' | 'route'>()
  expectTypeOf<BrainQuery>().toEqualTypeOf<{
    query?: string
    from?: string
    to?: string
    context?: string[]
    limit?: number
    sessionId?: string
    cwd?: string
  }>()
})

it('states a link with its wording, dates and the memories behind it', () => {
  expectTypeOf<BrainAgentMap['relate']>().toEqualTypeOf<{
    request: {
      subjectId: string
      predicate: BrainPredicate
      objectId: string
      label: string
      since?: string | null
      until?: string | null
      memoryIds: string[]
      suggestionId?: string
      reason: string
    }
    result: BrainAgentWrite
  }>()
  expectTypeOf<BrainAgentMap['correct']['request']>().toEqualTypeOf<{
    memoryId: string
    summary: string
    source: string
    quote: string
    links?: BrainLinkInput[]
    ends?: string[]
    reason: string
  }>()
  expectTypeOf<BrainAgentWrite['status']>().toEqualTypeOf<'done' | 'refused' | 'limit'>()
  expectTypeOf<BrainWaitingCounts>().toEqualTypeOf<{
    entities: number
    groups: number
    unlinked: number
    repeats: number
    conflicts: number
    flags: number
  }>()
})

it('describes a memory in plain words and centres the map on the owner', () => {
  expectTypeOf<BrainMemory['importance']>().toEqualTypeOf<0 | 1 | 2>()
  expectTypeOf<BrainMemory['saidBy']>().toEqualTypeOf<'you' | 'agent'>()
  expectTypeOf<BrainMemory['lanes']>().toEqualTypeOf<number>()
  expectTypeOf<BrainSnapshot['ownerId']>().toEqualTypeOf<string | null>()
  expectTypeOf<BrainJobState>().toEqualTypeOf<
    'waiting' | 'queued' | 'running' | 'empty' | 'failed' | 'done' | 'rejected'
  >()
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
    'reports_to',
    'works_with',
    'took_over_from',
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
