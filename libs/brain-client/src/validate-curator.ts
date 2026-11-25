import { BRAIN_ENTITY_KINDS, BRAIN_PREDICATES, type BrainEntityKind } from '@phosphor/shared/brain'
import {
  BRAIN_REASON_MAX,
  type BrainAgentEdit,
  type BrainAgentMap,
  type BrainResolve,
  type BrainLinkInput,
} from '@phosphor/shared/brain-agent'
import { checkBrainTidyAction } from '@phosphor/shared/brain-tidy'

/** Brain Agent's methods besides search, which every lane shares. */
export type BrainCuratorMethod = Exclude<keyof BrainAgentMap, 'search' | 'flag'>
type Request<M extends BrainCuratorMethod> = BrainAgentMap[M]['request']

/** Bounds every curator request shares; the engine checks what each id still names. */
export const BRAIN_CURATOR_LIMITS = {
  id: 200,
  waiting: 200,
  description: 160,
  label: 80,
  name: 200,
  splitMemories: 200,
  summary: 1200,
  source: 120,
  quote: 600,
} as const

class CuratorRequestError extends Error {}
const refuse = (message: string): never => {
  throw new CuratorRequestError(message)
}
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
function keys(
  input: unknown,
  required: string[],
  optional: string[] = [],
): Record<string, unknown> {
  if (!record(input)) return refuse('Brain request must be an object.')
  const allowed = [...required, ...optional]
  const extra = Object.keys(input).find((key) => !allowed.includes(key))
  if (extra) refuse(`Brain request has an unknown field: ${extra.slice(0, 40)}.`)
  const missing = required.find((key) => input[key] === undefined)
  if (missing) refuse(`Brain request needs ${missing}.`)
  return input
}
/** A trimmed, non-empty string of at most `max` characters with no NUL. */
function bounded(value: unknown, max: number, field: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > max || text.includes('\0'))
    refuse(`Brain ${field} needs 1 to ${max} characters.`)
  return text
}
const id = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value !== value.trim()) refuse(`Brain ${field} is invalid.`)
  return bounded(value, BRAIN_CURATOR_LIMITS.id, field)
}
const reason = (input: Record<string, unknown>): string =>
  bounded(input.reason, BRAIN_REASON_MAX, 'reason')
const kind = (value: unknown): BrainEntityKind =>
  (BRAIN_ENTITY_KINDS as readonly unknown[]).includes(value)
    ? (value as BrainEntityKind)
    : refuse(`Brain entity kind must be one of: ${BRAIN_ENTITY_KINDS.join(', ')}.`)

function edit(value: unknown): BrainAgentEdit {
  const kindOf = record(value) ? value.kind : undefined
  const limits = BRAIN_CURATOR_LIMITS
  if (kindOf === 'merge') {
    const v = keys(value, ['kind', 'sourceId', 'targetId'])
    return {
      kind: 'merge',
      sourceId: id(v.sourceId, 'sourceId'),
      targetId: id(v.targetId, 'targetId'),
    }
  }
  if (kindOf === 'describe') {
    const v = keys(value, ['kind', 'entityId', 'description'])
    return {
      kind: 'describe',
      entityId: id(v.entityId, 'entityId'),
      description: bounded(v.description, limits.description, 'description'),
    }
  }
  if (kindOf === 'split') {
    const v = keys(value, ['kind', 'entityId', 'memoryIds', 'label', 'entityKind'])
    const memoryIds = Array.isArray(v.memoryIds) ? v.memoryIds.map((m) => id(m, 'memoryIds')) : []
    if (
      !memoryIds.length ||
      memoryIds.length > limits.splitMemories ||
      new Set(memoryIds).size !== memoryIds.length
    )
      refuse(`Brain split needs 1 to ${limits.splitMemories} different memory ids.`)
    return {
      kind: 'split',
      entityId: id(v.entityId, 'entityId'),
      memoryIds,
      label: bounded(v.label, limits.label, 'label'),
      entityKind: kind(v.entityKind),
    }
  }
  if (kindOf === 'removeName') {
    const v = keys(value, ['kind', 'entityId', 'name'])
    return {
      kind: 'removeName',
      entityId: id(v.entityId, 'entityId'),
      name: bounded(v.name, limits.name, 'name'),
    }
  }
  if (kindOf === 'importance') {
    const v = keys(value, ['kind', 'memoryId', 'importance'])
    if (v.importance !== 'low' && v.importance !== 'normal' && v.importance !== 'high')
      return refuse('Choose low, normal or high importance.')
    return { kind: 'importance', memoryId: id(v.memoryId, 'memoryId'), importance: v.importance }
  }
  if (kindOf === 'relation') {
    const v = keys(value, ['kind', 'relationId'], ['label', 'since', 'until'])
    if (v.label === undefined && v.since === undefined && v.until === undefined)
      return refuse('Specify wording or a date to edit.')
    return {
      kind: 'relation',
      relationId: id(v.relationId, 'relationId'),
      ...dates(v),
      ...(v.label === undefined ? {} : { label: bounded(v.label, 80, 'label') }),
    }
  }
  return refuse('Unknown Brain edit kind.')
}

function action(value: unknown): BrainResolve['action'] {
  if (record(value) && value.kind === 'forget') refuse('Erase a memory with erase, not resolve.')
  try {
    return checkBrainTidyAction(value) as BrainResolve['action']
  } catch {
    return refuse(
      'Brain action must be merge or fold (survivorId), replace (newerId), dispute, group, keep, or unname (entityId, name).',
    )
  }
}

function dates(v: Record<string, unknown>) {
  function date(x: unknown): string | null {
    if (x === null) return null
    if (
      typeof x !== 'string' ||
      !/^\d{4}-\d\d-\d\d$/.test(x) ||
      !Number.isFinite(Date.parse(x)) ||
      new Date(x).toISOString().slice(0, 10) !== x
    )
      return refuse('Brain dates must be YYYY-MM-DD.')
    return x
  }
  const result = {
    ...(v.since === undefined ? {} : { since: date(v.since) }),
    ...(v.until === undefined ? {} : { until: date(v.until) }),
  }
  if (result.since && result.until && result.since > result.until)
    refuse('The end cannot precede the start.')
  return result
}
const linkFields = ['subjectId', 'predicate', 'objectId', 'label']
function link(v: Record<string, unknown>): BrainLinkInput {
  const subjectId = id(v.subjectId, 'subjectId'),
    objectId = id(v.objectId, 'objectId')
  if (subjectId === objectId) refuse('Link two different records.')
  const predicate = BRAIN_PREDICATES.find((p) => p === v.predicate)
  if (!predicate) return refuse('Unknown Brain link predicate.')
  return { subjectId, predicate, objectId, label: bounded(v.label, 80, 'label'), ...dates(v) }
}
function ids(v: unknown, field: string, min: number, max: number) {
  if (!Array.isArray(v) || v.length < min || v.length > max || new Set(v).size !== v.length)
    return refuse(`Brain ${field} needs ${min} to ${max} different ids.`)
  return v.map((x) => id(x, field))
}
const VALIDATORS: { [M in BrainCuratorMethod]: (input: unknown) => Request<M> } = {
  waiting: (input) => {
    const v = keys(input, [], ['limit'])
    if (
      v.limit !== undefined &&
      (!Number.isInteger(v.limit) ||
        (v.limit as number) < 1 ||
        (v.limit as number) > BRAIN_CURATOR_LIMITS.waiting)
    )
      refuse(`Brain waiting limit must be 1 to ${BRAIN_CURATOR_LIMITS.waiting}.`)
    return v.limit === undefined ? {} : { limit: v.limit as number }
  },
  suggestion: (input) => ({
    suggestionId: id(keys(input, ['suggestionId']).suggestionId, 'suggestionId'),
  }),
  entity: (input) => ({ entityId: id(keys(input, ['entityId']).entityId, 'entityId') }),
  memory: (input) => ({ memoryId: id(keys(input, ['memoryId']).memoryId, 'memoryId') }),
  relate: (input) => {
    const v = keys(
      input,
      [...linkFields, 'memoryIds', 'reason'],
      ['since', 'until', 'suggestionId'],
    )
    return {
      ...link(v),
      memoryIds: ids(v.memoryIds, 'memoryIds', 1, 8),
      reason: reason(v),
      ...(v.suggestionId === undefined ? {} : { suggestionId: id(v.suggestionId, 'suggestionId') }),
    }
  },
  resolve: (input) => {
    const v = keys(input, ['suggestionId', 'action', 'reason'])
    return {
      suggestionId: id(v.suggestionId, 'suggestionId'),
      action: action(v.action),
      reason: reason(v),
    }
  },
  edit: (input) => {
    const v = keys(input, ['edit', 'reason'])
    return { edit: edit(v.edit), reason: reason(v) }
  },
  correct: (input) => {
    const v = keys(input, ['memoryId', 'summary', 'source', 'quote', 'reason'], ['links', 'ends'])
    if (v.links !== undefined && (!Array.isArray(v.links) || v.links.length > 200))
      return refuse('Brain links must be a bounded list.')
    const limits = BRAIN_CURATOR_LIMITS
    return {
      memoryId: id(v.memoryId, 'memoryId'),
      ...(Array.isArray(v.links)
        ? { links: v.links.map((x) => link(keys(x, linkFields, ['since', 'until']))) }
        : {}),
      ...(v.ends === undefined ? {} : { ends: ids(v.ends, 'ends', 0, 200) }),
      summary: bounded(v.summary, limits.summary, 'summary'),
      source: bounded(v.source, limits.source, 'source'),
      quote: bounded(v.quote, limits.quote, 'quote'),
      reason: reason(v),
    }
  },
  erase: (input) => {
    const v = keys(input, ['memoryId', 'reason'])
    return { memoryId: id(v.memoryId, 'memoryId'), reason: reason(v) }
  },
  undo: (input) => {
    const v = keys(input, ['operationId', 'reason'])
    return { operationId: id(v.operationId, 'operationId'), reason: reason(v) }
  },
}

export const isBrainCuratorMethod = (method: unknown): method is BrainCuratorMethod =>
  typeof method === 'string' && Object.hasOwn(VALIDATORS, method)

/**
 * A curator request with exactly its keys, bounded ids (≤ 200) and strings, and a trimmed reason
 * of 1–300 characters. Returns a fresh object; throws a sentence the agent can act on.
 */
export function validateCuratorRequest<M extends BrainCuratorMethod>(
  method: M,
  input: unknown,
): Request<M> {
  return VALIDATORS[method](input) as Request<M>
}

/** A refusal from validateCuratorRequest: its message is safe to show the agent. */
export const isCuratorRequestError = (error: unknown): error is Error =>
  error instanceof CuratorRequestError
