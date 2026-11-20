import { BRAIN_ENTITY_KINDS, type BrainEntityKind } from '@phosphor/shared/brain'
import {
  BRAIN_REASON_MAX,
  type BrainAgentEdit,
  type BrainAgentMap,
  type BrainResolve,
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
  /** Indexes, identity answers or description refs in one decision, as brain_decide_read takes. */
  choices: 400,
  /** An identity ref, such as e1. */
  ref: 64,
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
  return refuse('Brain edit kind must be merge, describe, split or removeName.')
}

function action(value: unknown): BrainResolve['action'] {
  if (record(value) && value.kind === 'forget') refuse('Erase a memory with erase, not resolve.')
  try {
    return checkBrainTidyAction(value) as BrainResolve['action']
  } catch {
    return refuse(
      'Brain action must be merge or fold (survivorId), replace (newerId), dispute, keep, or unname (entityId, name).',
    )
  }
}

const offset = (value: unknown): { offset?: number } => {
  if (value === undefined) return {}
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    refuse('Brain review offset must be a whole number, 0 or more.')
  return { offset: value as number }
}

/** Brain Agent's optional choices on an approval, each within brain_decide_read's own limits. */
function choices(
  v: Record<string, unknown>,
): Omit<Request<'decideRead'>, 'jobId' | 'revision' | 'approve' | 'reason'> {
  const { choices: most, ref, id: answer } = BRAIN_CURATOR_LIMITS
  const list = <T>(field: string, item: (value: unknown) => T): { [field: string]: T[] } => {
    const value = v[field]
    if (value === undefined) return {}
    if (!Array.isArray(value) || value.length > most)
      refuse(`Brain ${field} must be a list of at most ${most}.`)
    return { [field]: (value as unknown[]).map(item) }
  }
  const index = (field: string) => (value: unknown) =>
    Number.isSafeInteger(value) && (value as number) >= 0
      ? (value as number)
      : refuse(`Brain ${field} must be indexes of 0 or more.`)
  const name = (value: unknown, max: number, field: string): string =>
    typeof value === 'string' && value && value.length <= max && !value.includes('\0')
      ? value
      : refuse(`Brain ${field} needs 1 to ${max} characters.`)
  return {
    ...list('memories', index('memories')),
    ...list('identities', (value) => {
      const i = keys(value, ['ref', 'answer'])
      return {
        ref: name(i.ref, ref, 'identity ref'),
        answer: name(i.answer, answer, 'identity answer'),
      }
    }),
    ...list('groups', index('groups')),
    ...list('descriptions', (value) => name(value, ref, 'description ref')),
    ...list('confirmations', index('confirmations')),
  }
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
  readReview: (input) => {
    const v = keys(input, ['jobId'], ['offset'])
    return { jobId: id(v.jobId, 'jobId'), ...offset(v.offset) }
  },
  suggestion: (input) => ({
    suggestionId: id(keys(input, ['suggestionId']).suggestionId, 'suggestionId'),
  }),
  entity: (input) => ({ entityId: id(keys(input, ['entityId']).entityId, 'entityId') }),
  memory: (input) => ({ memoryId: id(keys(input, ['memoryId']).memoryId, 'memoryId') }),
  decideRead: (input) => {
    const v = keys(
      input,
      ['jobId', 'revision', 'approve', 'reason'],
      ['memories', 'identities', 'groups', 'descriptions', 'confirmations'],
    )
    if (!Number.isSafeInteger(v.revision) || (v.revision as number) < 0)
      refuse('Brain revision must be the review’s revision number.')
    if (typeof v.approve !== 'boolean') refuse('Brain approve must be true or false.')
    return {
      jobId: id(v.jobId, 'jobId'),
      revision: v.revision as number,
      approve: v.approve as boolean,
      ...choices(v),
      reason: reason(v),
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
    const v = keys(input, ['memoryId', 'summary', 'source', 'quote', 'reason'])
    const limits = BRAIN_CURATOR_LIMITS
    return {
      memoryId: id(v.memoryId, 'memoryId'),
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
