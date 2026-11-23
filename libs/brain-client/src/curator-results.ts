import { BRAIN_ENTITY_KINDS } from '@phosphor/shared/brain'
import type { BrainAgentMap } from '@phosphor/shared/brain-agent'
import type { BrainCuratorMethod } from './validate-curator'
import { isBrainMemory } from './validate'

/*
 * Shallow guards for what Brain returns to Brain Agent: each checks the fields the tools print,
 * so a malformed answer is refused instead of formatted. Text in them is stored data.
 */
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const count = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) >= 0
const strings = (v: unknown): boolean => Array.isArray(v) && v.every((s) => typeof s === 'string')
const list = (v: unknown, item: (value: unknown) => boolean): boolean =>
  Array.isArray(v) && v.every(item)
const entity = (v: unknown): boolean =>
  record(v) &&
  typeof v.id === 'string' &&
  typeof v.label === 'string' &&
  (BRAIN_ENTITY_KINDS as readonly unknown[]).includes(v.kind) &&
  strings(v.aliases) &&
  typeof v.description === 'string'

const COUNT_KEYS = ['reads', 'entities', 'repeats', 'conflicts', 'flags']
const WAITING_KINDS = ['same_entity', 'same_memory', 'conflict', 'flagged', 'possible_repeat']

function waitingItem(v: unknown): boolean {
  if (!record(v)) return false
  if (v.kind === 'read')
    return (
      typeof v.jobId === 'string' &&
      typeof v.title === 'string' &&
      (v.state === 'review' || v.state === 'refreshing') &&
      count(v.memories) &&
      count(v.questions) &&
      typeof v.neverRead === 'boolean'
    )
  return (
    WAITING_KINDS.includes(v.kind as string) &&
    typeof v.suggestionId === 'string' &&
    typeof v.reason === 'string' &&
    list(
      v.subjects,
      (s) =>
        record(s) &&
        (s.type === 'entity' || s.type === 'memory') &&
        typeof s.id === 'string' &&
        typeof s.label === 'string',
    )
  )
}

export function isBrainWaiting(v: unknown): v is BrainAgentMap['waiting']['result'] {
  return (
    record(v) &&
    record(v.counts) &&
    COUNT_KEYS.every((key) => count((v.counts as Record<string, unknown>)[key])) &&
    list(v.items, waitingItem) &&
    count(v.more)
  )
}

/** One page of a read, formatted by the runtime. */
export function isBrainReadReviewPage(v: unknown): v is BrainAgentMap['readReview']['result'] {
  return record(v) && Object.keys(v).length === 1 && typeof v.text === 'string'
}

export function isBrainSuggestionDetail(v: unknown): v is BrainAgentMap['suggestion']['result'] {
  return (
    v === null ||
    (record(v) &&
      record(v.suggestion) &&
      typeof v.suggestion.id === 'string' &&
      typeof v.suggestion.kind === 'string' &&
      typeof v.suggestion.reason === 'string' &&
      list(
        v.subjects,
        (s) => record(s) && (s.type === 'entity' || s.type === 'memory') && record(s.value),
      ) &&
      strings(v.allowed) &&
      count(v.revision))
  )
}

export function isBrainEntityView(v: unknown): v is BrainAgentMap['entity']['result'] {
  return (
    record(v) &&
    entity(v.entity) &&
    list(v.sources, (s) => record(s) && typeof s.title === 'string') &&
    list(v.groups, (g) => record(g) && typeof g.predicate === 'string' && Array.isArray(g.items)) &&
    record(v.memoryCounts) &&
    strings(v.merged)
  )
}

export function isBrainMemoryDetail(v: unknown): v is BrainAgentMap['memory']['result'] {
  return (
    record(v) &&
    isBrainMemory(v.memory) &&
    list(v.quotes, (q) => record(q) && typeof q.quote === 'string') &&
    list(v.entities, entity) &&
    list(v.history, isBrainMemory) &&
    list(v.related, (r) => record(r) && isBrainMemory(r.memory))
  )
}

export function isBrainAgentWrite(v: unknown): v is BrainAgentMap['decideRead']['result'] {
  return (
    record(v) &&
    Object.keys(v).length === 3 &&
    ['done', 'changed', 'refused', 'limit'].includes(v.status as string) &&
    typeof v.message === 'string' &&
    v.message.length <= 500 &&
    (v.operationId === null || typeof v.operationId === 'string')
  )
}

export const CURATOR_RESULT_GUARDS: { [M in BrainCuratorMethod]: (v: unknown) => boolean } = {
  waiting: isBrainWaiting,
  readReview: isBrainReadReviewPage,
  suggestion: isBrainSuggestionDetail,
  entity: isBrainEntityView,
  memory: isBrainMemoryDetail,
  decideRead: isBrainAgentWrite,
  resolve: isBrainAgentWrite,
  edit: isBrainAgentWrite,
  correct: isBrainAgentWrite,
  erase: isBrainAgentWrite,
  undo: isBrainAgentWrite,
}
