import {
  BRAIN_ENTITY_KINDS,
  BRAIN_MEMORY_TYPES,
  BRAIN_PREDICATES,
  type BrainAgentMap,
  type BrainAgentMethod,
  type BrainMemory,
  type BrainRecall,
} from '@phosphor/shared/brain'

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === 'string')
const nullableString = (v: unknown): boolean => v === null || typeof v === 'string'
const member = (v: unknown, values: readonly string[]): boolean =>
  typeof v === 'string' && values.includes(v)
const hasStrings = (v: Record<string, unknown>, keys: string[]): boolean =>
  keys.every((key) => typeof v[key] === 'string')

export function validateBrainRequest<M extends BrainAgentMethod>(
  method: M,
  input: unknown,
): BrainAgentMap[M]['request'] {
  if (method !== 'search' || !record(input)) throw new Error('Invalid Brain request.')
  const text = input.query
  const keys = new Set(['query', 'limit', 'sessionId', 'cwd'])
  if (
    Object.keys(input).some((k) => !keys.has(k)) ||
    typeof text !== 'string' ||
    !text.trim() ||
    text.length > 2000 ||
    (input.limit !== undefined &&
      (!number(input.limit) ||
        !Number.isInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 20)) ||
    (input.sessionId !== undefined &&
      (typeof input.sessionId !== 'string' || !input.sessionId || input.sessionId.length > 256)) ||
    (input.cwd !== undefined &&
      (typeof input.cwd !== 'string' ||
        !input.cwd ||
        input.cwd.length > 16384 ||
        input.cwd.includes('\0')))
  )
    throw new Error('Invalid Brain request.')
  return input as unknown as BrainAgentMap[M]['request']
}

function link(v: unknown): boolean {
  return (
    record(v) &&
    hasStrings(v, ['id', 'subjectId', 'objectId', 'memoryId']) &&
    member(v.predicate, BRAIN_PREDICATES)
  )
}
const date = (v: unknown): boolean => v === null || number(v)

function memory(v: unknown): v is BrainMemory {
  return (
    record(v) &&
    hasStrings(v, ['id', 'summary', 'scope']) &&
    member(v.type, BRAIN_MEMORY_TYPES) &&
    member(v.kind, ['observed', 'reported', 'inferred']) &&
    member(v.state, ['active', 'superseded', 'disputed']) &&
    strings(v.entityIds) &&
    Array.isArray(v.links) &&
    v.links.every(link) &&
    nullableString(v.jobId) &&
    nullableString(v.branch) &&
    date(v.validFrom) &&
    date(v.validTo) &&
    number(v.recordedAt) &&
    number(v.observedAt) &&
    (v.origin === null || (record(v.origin) && hasStrings(v.origin, ['sessionId', 'title'])))
  )
}

export function isBrainRecall(v: unknown): v is BrainRecall {
  return (
    record(v) &&
    member(v.status, ['ok', 'no_match', 'unavailable']) &&
    strings(v.degradation) &&
    Array.isArray(v.hits) &&
    v.hits.every(
      (hit: unknown) =>
        record(hit) &&
        memory(hit.memory) &&
        number(hit.score) &&
        strings(hit.reasons) &&
        hit.reasons.every((r) => ['exact', 'lexical', 'semantic', 'linked'].includes(r)),
    ) &&
    strings(v.focus) &&
    Array.isArray(v.paths) &&
    v.paths.every((path: unknown) => Array.isArray(path) && path.every(link)) &&
    nullableString(v.branch) &&
    number(v.more) &&
    Number.isInteger(v.more) &&
    v.more >= 0 &&
    Array.isArray(v.entities) &&
    v.entities.every(
      (e: unknown) =>
        record(e) &&
        hasStrings(e, ['id', 'label']) &&
        member(e.kind, BRAIN_ENTITY_KINDS) &&
        strings(e.aliases) &&
        typeof e.description === 'string',
    )
  )
}
