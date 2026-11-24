import {
  BRAIN_ENTITY_KINDS,
  BRAIN_MEMORY_TYPES,
  BRAIN_PREDICATES,
  type BrainAgentMap,
  type BrainFlagResponse,
  type BrainAgentMethod,
  type BrainMemory,
} from '@phosphor/shared/brain'
import type { BrainSearchResult } from '@phosphor/shared/brain-recall'
import { isBrainCuratorMethod, validateCuratorRequest } from './validate-curator'

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

/** Search, flag, or one of Brain Agent's curator methods (validate-curator.ts). */
export function validateBrainRequest<M extends BrainAgentMethod>(
  method: M,
  input: unknown,
): BrainAgentMap[M]['request'] {
  if (method === 'flag') return validateFlag(input) as BrainAgentMap[M]['request']
  if (isBrainCuratorMethod(method))
    return validateCuratorRequest(method, input) as BrainAgentMap[M]['request']
  if (method !== 'search' || !record(input)) throw new Error('Invalid Brain request.')
  const text = (x: unknown, max: number) =>
    typeof x === 'string' && !!x.trim() && x.length <= max && !x.includes('\0')
  const mode =
    input.query !== undefined
      ? text(input.query, 2000) &&
        input.from === undefined &&
        input.to === undefined &&
        input.context === undefined
      : text(input.from, 200) &&
        (input.to === undefined || (text(input.to, 200) && input.context === undefined)) &&
        (input.context === undefined ||
          (Array.isArray(input.context) &&
            input.context.length <= 5 &&
            input.context.every((x) => text(x, 200))))
  const keys = new Set(['query', 'from', 'to', 'context', 'limit', 'sessionId', 'cwd'])
  if (
    Object.keys(input).some((k) => !keys.has(k)) ||
    !mode ||
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

export function isBrainLink(v: unknown): boolean {
  return (
    record(v) &&
    hasStrings(v, ['id', 'subjectId', 'objectId', 'memoryId']) &&
    member(v.predicate, BRAIN_PREDICATES) &&
    typeof v.label === 'string' &&
    member(v.statedBy, ['agent', 'reader', 'owner']) &&
    date(v.validFrom) &&
    date(v.validTo)
  )
}
const date = (v: unknown): boolean => v === null || number(v)

export function isBrainMemory(v: unknown): v is BrainMemory {
  return (
    record(v) &&
    hasStrings(v, ['id', 'summary', 'scope']) &&
    [0, 1, 2].includes(v.importance as number) &&
    member(v.saidBy, ['you', 'agent']) &&
    Number.isSafeInteger(v.lanes) &&
    member(v.type, BRAIN_MEMORY_TYPES) &&
    member(v.kind, ['observed', 'reported', 'inferred']) &&
    member(v.state, ['active', 'superseded', 'disputed']) &&
    strings(v.entityIds) &&
    Array.isArray(v.links) &&
    v.links.every(isBrainLink) &&
    nullableString(v.jobId) &&
    nullableString(v.branch) &&
    date(v.validFrom) &&
    date(v.validTo) &&
    number(v.recordedAt) &&
    number(v.observedAt) &&
    (v.origin === null || (record(v.origin) && hasStrings(v.origin, ['sessionId', 'title'])))
  )
}

const list = (v: unknown, check: (x: unknown) => boolean) => Array.isArray(v) && v.every(check)
const entity = (v: unknown) =>
  record(v) &&
  hasStrings(v, ['id', 'label', 'description']) &&
  member(v.kind, BRAIN_ENTITY_KINDS) &&
  strings(v.aliases)
const hit = (v: unknown) =>
  record(v) &&
  isBrainMemory(v.memory) &&
  number(v.score) &&
  strings(v.reasons) &&
  v.reasons.every((r) => member(r, ['exact', 'lexical', 'semantic', 'linked'])) &&
  (v.trail === null ||
    (record(v.trail) &&
      hasStrings(v.trail, ['entityId', 'seedId']) &&
      list(v.trail.links, isBrainLink)))
const relationLine = (v: unknown) =>
  record(v) && isBrainLink(v.link) && entity(v.other) && number(v.supports)
const routeStep = (v: unknown) =>
  record(v) &&
  ((v.kind === 'relation' && isBrainLink(v.link)) ||
    (v.kind === 'together' && hasStrings(v, ['fromId', 'toId', 'memoryId']) && number(v.shared)))
export function isBrainRecall(v: unknown): v is BrainSearchResult {
  if (
    !record(v) ||
    !member(v.status, ['ok', 'no_match', 'unavailable']) ||
    !list(v.entities, entity)
  )
    return false
  if (v.mode === 'route')
    return (
      (v.from === null || entity(v.from)) &&
      (v.to === null || entity(v.to)) &&
      list(v.routes, (r) => list(r, routeStep)) &&
      list(v.memories, isBrainMemory)
    )
  if (!list(v.hits, hit) || !strings(v.degradation)) return false
  if (v.mode === 'expand')
    return (
      (v.entity === null || entity(v.entity)) &&
      list(v.alternatives, entity) &&
      list(v.current, relationLine) &&
      list(
        v.currentMore,
        (g) =>
          record(g) &&
          member(g.predicate, BRAIN_PREDICATES) &&
          member(g.direction, ['in', 'out']) &&
          number(g.more),
      ) &&
      list(v.ended, relationLine) &&
      list(v.together, (t) => record(t) && entity(t.entity) && number(t.shared)) &&
      number(v.togetherMore)
    )
  return (
    v.mode === 'search' &&
    strings(v.focus) &&
    nullableString(v.branch) &&
    number(v.more) &&
    Number.isInteger(v.more) &&
    v.more >= 0
  )
}

function validateFlag(input: unknown): BrainAgentMap['flag']['request'] {
  const bounded = (value: unknown, max: number): value is string =>
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= max &&
    !value.includes('\0')
  if (
    !record(input) ||
    Object.keys(input).some(
      (key) => !['memoryId', 'problem', 'reason', 'sessionId', 'title'].includes(key),
    ) ||
    !bounded(input.memoryId, 200) ||
    !bounded(input.sessionId, 256) ||
    !bounded(input.title, 120) ||
    !bounded(input.reason, 300) ||
    !member(input.problem, ['wrong', 'outdated', 'duplicate'])
  )
    throw new Error(
      'Invalid Brain flag: use a known memory, a problem and a reason of 1 to 300 characters.',
    )
  return input as unknown as BrainAgentMap['flag']['request']
}
export function isBrainFlagResponse(input: unknown): input is BrainFlagResponse {
  return (
    record(input) &&
    Object.keys(input).length === 2 &&
    member(input.status, ['filed', 'already_flagged', 'limit', 'unavailable']) &&
    typeof input.message === 'string' &&
    input.message.length > 0 &&
    input.message.length <= 300
  )
}
