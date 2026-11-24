/**
 * Brain Agent's write tools (brain-curator.ts registers them). Every one takes a one-sentence
 * reason that the journal keeps and the owner reads; every result says how to undo it.
 */
import { Type } from 'typebox'
import { BRAIN_ENTITY_KINDS, BRAIN_PREDICATES, type BrainEntityKind } from '@phosphor/shared/brain'
import type {
  BrainAgentEdit,
  BrainAgentWrite,
  BrainRelate,
  BrainCorrect,
  BrainResolve,
} from '@phosphor/shared/brain-agent'
import type { BrainCuratorClient } from '@phosphor/brain-client/curator-client'
import { formatWrite } from '@phosphor/brain-client/curator-format'
import type { EventApi, ToolDefinition } from './pi-api'

export interface CuratorPiApi extends EventApi {
  registerTool<P, D>(definition: ToolDefinition<P, unknown, D>): void
}
export const curatorId = (description: string) =>
  Type.String({ minLength: 1, maxLength: 200, description })
export const reply = (text: string, status = 'ok') => ({
  content: [{ type: 'text' as const, text }],
  details: { status },
})
const reason = Type.String({
  minLength: 1,
  maxLength: 300,
  description: 'One sentence saying why. The journal keeps it and the owner reads it.',
})
const object = (properties: Parameters<typeof Type.Object>[0]) =>
  Type.Object(properties, { additionalProperties: false })
const literals = <T extends string>(values: readonly T[], description: string) =>
  Type.Union(
    values.map((value) => Type.Literal(value)),
    { description },
  )

function registerWrite<P>(
  pi: CuratorPiApi,
  name: string,
  label: string,
  description: string,
  parameters: unknown,
  run: (params: P, signal: AbortSignal | undefined) => Promise<BrainAgentWrite | string>,
): void {
  pi.registerTool<P, { status: string }>({
    name,
    label,
    description,
    parameters,
    execute: async (_id, params, signal) => {
      const result = await run(params, signal)
      return typeof result === 'string'
        ? reply(result, 'refused')
        : reply(formatWrite(result), result.status)
    },
  })
}

type ResolveParams = {
  suggestionId: string
  action: BrainResolve['action']['kind']
  survivorId?: string
  newerId?: string
  entityId?: string
  name?: string
  reason: string
}
/** The action brain_resolve's flat parameters describe, or the field it lacks. */
export function resolveAction(p: ResolveParams): BrainResolve['action'] | string {
  if (p.action === 'merge' || p.action === 'fold')
    return p.survivorId
      ? { kind: p.action, survivorId: p.survivorId }
      : `${p.action} needs survivorId: the id of the record to keep.`
  if (p.action === 'replace')
    return p.newerId
      ? { kind: 'replace', newerId: p.newerId }
      : 'replace needs newerId: the newer memory.'
  if (p.action === 'unname')
    return p.entityId && p.name
      ? { kind: 'unname', entityId: p.entityId, name: p.name }
      : 'unname needs entityId and name: the record that loses the name, and the name.'
  return { kind: p.action }
}

type EditParams = {
  relationId?: string
  since?: string | null
  until?: string | null
  importance?: 'low' | 'normal' | 'high'
  memoryId?: string
  kind: BrainAgentEdit['kind']
  sourceId?: string
  targetId?: string
  entityId?: string
  description?: string
  memoryIds?: string[]
  label?: string
  entityKind?: BrainEntityKind
  name?: string
  reason: string
}
/** The edit brain_edit's flat parameters describe, or the fields it lacks. */
export function editOf(p: EditParams): BrainAgentEdit | string {
  if (p.kind === 'merge')
    return p.sourceId && p.targetId
      ? { kind: 'merge', sourceId: p.sourceId, targetId: p.targetId }
      : 'merge needs sourceId (merged away) and targetId (kept).'
  if (p.kind === 'importance')
    return p.memoryId && p.importance
      ? { kind: p.kind, memoryId: p.memoryId, importance: p.importance }
      : 'importance needs memoryId and importance.'
  if (p.kind === 'relation')
    return p.relationId
      ? { kind: p.kind, relationId: p.relationId, label: p.label, since: p.since, until: p.until }
      : 'relation needs relationId.'
  if (!p.entityId) return `${p.kind} needs entityId.`
  if (p.kind === 'describe')
    return p.description
      ? { kind: 'describe', entityId: p.entityId, description: p.description }
      : 'describe needs description.'
  if (p.kind === 'removeName')
    return p.name
      ? { kind: 'removeName', entityId: p.entityId, name: p.name }
      : 'removeName needs name.'
  return p.memoryIds?.length && p.label && p.entityKind
    ? {
        kind: 'split',
        entityId: p.entityId,
        memoryIds: p.memoryIds,
        label: p.label,
        entityKind: p.entityKind,
      }
    : 'split needs memoryIds, label and entityKind for the new record.'
}

export function registerCuratorWrites(pi: CuratorPiApi, client: BrainCuratorClient): void {
  registerRelate(pi, client)
  registerWrite<ResolveParams>(
    pi,
    'brain_resolve',
    'Brain: resolve a suggestion',
    'Resolve a suggestion from brain_suggestion with one of its allowed actions. merge (people and things) and fold (repeats) keep survivorId; replace keeps newerId as current; dispute keeps both memories as disputed; keep leaves both as they are and closes it; group confirms the proposed parent; unname removes a shared name (name) from one record (entityId). To erase a memory use brain_erase.',
    object({
      suggestionId: curatorId('The suggestion id.'),
      action: literals(
        ['merge', 'fold', 'replace', 'dispute', 'keep', 'group', 'unname'],
        'What to do.',
      ),
      survivorId: Type.Optional(curatorId('merge or fold: the record to keep.')),
      newerId: Type.Optional(curatorId('replace: the newer memory, which stays current.')),
      entityId: Type.Optional(curatorId('unname: the record that loses the name.')),
      name: Type.Optional(
        Type.String({ minLength: 1, maxLength: 200, description: 'unname: the name to remove.' }),
      ),
      reason,
    }),
    async (p, signal) => {
      const action = resolveAction(p)
      if (typeof action === 'string') return action
      return client.call(
        'resolve',
        { suggestionId: p.suggestionId, action, reason: p.reason },
        signal,
      )
    },
  )
  registerEdit(pi, client)
  registerFixes(pi, client)
}

const date = Type.Optional(
  Type.Union([Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }), Type.Null()]),
)
const link = {
  subjectId: curatorId('Subject entity id.'),
  predicate: literals(BRAIN_PREDICATES, 'Relationship category.'),
  objectId: curatorId('Object entity id.'),
  label: Type.String({
    minLength: 1,
    maxLength: 80,
    description: 'Wording read from subject to object.',
  }),
  since: date,
  until: date,
}
function registerRelate(pi: CuratorPiApi, client: BrainCuratorClient) {
  registerWrite<BrainRelate>(
    pi,
    'brain_relate',
    'Brain: state a relationship',
    'State a lasting relationship only when shared memories show it. Cite one to eight memories; otherwise keep the pair apart.',
    object({
      ...link,
      memoryIds: Type.Array(curatorId('Citing memory id.'), { minItems: 1, maxItems: 8 }),
      suggestionId: Type.Optional(curatorId('Unlinked pair to settle.')),
      reason,
    }),
    async (p, signal) => client.call('relate', p, signal),
  )
}
function registerEdit(pi: CuratorPiApi, client: BrainCuratorClient): void {
  registerWrite<EditParams>(
    pi,
    'brain_edit',
    'Brain: edit a person or thing',
    'Edit people and things directly. merge folds sourceId into targetId. describe sets a short description (≤160 characters) that tells it apart. split moves memoryIds off entityId into a new record named label of kind entityKind. removeName removes one name from entityId. relation edits wording and dates; importance changes a memory’s priority.',
    object({
      kind: literals(
        ['merge', 'describe', 'split', 'removeName', 'relation', 'importance'],
        'The edit.',
      ),
      relationId: Type.Optional(curatorId('Relationship to edit.')),
      since: date,
      until: date,
      memoryId: Type.Optional(curatorId('Memory whose importance changes.')),
      importance: Type.Optional(literals(['low', 'normal', 'high'], 'New importance.')),
      sourceId: Type.Optional(curatorId('merge: the record merged away.')),
      targetId: Type.Optional(curatorId('merge: the record kept.')),
      entityId: Type.Optional(curatorId('describe, split, removeName: the record.')),
      description: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
      memoryIds: Type.Optional(
        Type.Array(curatorId('A memory id.'), { minItems: 1, maxItems: 200 }),
      ),
      label: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 80,
          description: 'For split: the new name. For relation: the new wording.',
        }),
      ),
      entityKind: Type.Optional(literals(BRAIN_ENTITY_KINDS, 'split: the new record’s kind.')),
      name: Type.Optional(
        Type.String({ minLength: 1, maxLength: 200, description: 'removeName: the name.' }),
      ),
      reason,
    }),
    async (p, signal) => {
      const edit = editOf(p)
      return typeof edit === 'string'
        ? edit
        : client.call('edit', { edit, reason: p.reason }, signal)
    },
  )
}

function registerFixes(pi: CuratorPiApi, client: BrainCuratorClient): void {
  registerWrite<BrainCorrect>(
    pi,
    'brain_correct',
    'Brain: correct a memory',
    'Replace a memory with a corrected one when a source (Linear, Notion, Slack, GitHub) states the new truth. summary is the corrected self-contained sentence; quote is the exact words from the source; source names it, such as "Linear KES-12" or "Slack #ledger". Include the links the correction states, and relation ids it ends. Undo restores the old memory.',
    object({
      memoryId: curatorId('The memory to correct.'),
      links: Type.Optional(Type.Array(object(link), { maxItems: 200 })),
      ends: Type.Optional(Type.Array(curatorId('Relation to end.'), { maxItems: 200 })),
      summary: Type.String({ minLength: 1, maxLength: 1200 }),
      source: Type.String({ minLength: 1, maxLength: 120 }),
      quote: Type.String({ minLength: 1, maxLength: 600 }),
      reason,
    }),
    async (p, signal) => client.call('correct', p, signal),
  )
  registerWrite<{ memoryId: string; reason: string }>(
    pi,
    'brain_erase',
    'Brain: erase a memory',
    'Erase a memory you are confident was superseded or will not help any future lane. Final: it cannot be undone, and Brain keeps only your reason, never the memory’s text, so the reason must not quote or restate the memory. At most 25 erasures an hour. Prefer brain_resolve (fold, replace) when another memory covers it.',
    object({
      memoryId: curatorId('The memory to erase.'),
      reason: Type.String({
        minLength: 1,
        maxLength: 300,
        description:
          'Why, in one sentence, without quoting the memory. The journal keeps only this.',
      }),
    }),
    async (p, signal) => client.call('erase', p, signal),
  )
  registerWrite<{ operationId: string; reason: string }>(
    pi,
    'brain_undo',
    'Brain: undo a change',
    'Undo one Brain change by its operation id (shown after each change). Erasures cannot be undone.',
    object({ operationId: curatorId('The operation id.'), reason }),
    async (p, signal) => client.call('undo', p, signal),
  )
}
