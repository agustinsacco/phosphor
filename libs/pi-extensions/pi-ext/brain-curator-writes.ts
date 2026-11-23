/**
 * Brain Agent's write tools (brain-curator.ts registers them). Every one takes a one-sentence
 * reason that the journal keeps and the owner reads; every result says how to undo it.
 */
import { Type } from 'typebox'
import { BRAIN_ENTITY_KINDS, type BrainEntityKind } from '@phosphor/shared/brain'
import type {
  BrainAgentEdit,
  BrainAgentWrite,
  BrainDecideRead,
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
const indexes = (description: string) =>
  Type.Optional(Type.Array(Type.Integer({ minimum: 0 }), { maxItems: 400, description }))
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
  registerDecide(pi, client)
  registerWrite<ResolveParams>(
    pi,
    'brain_resolve',
    'Brain: resolve a suggestion',
    'Resolve a suggestion from brain_suggestion with one of its allowed actions. merge (people and things) and fold (repeats) keep survivorId; replace keeps newerId as current; dispute keeps both memories as disputed; keep leaves both as they are and closes it; unname removes a shared name (name) from one record (entityId). To erase a memory use brain_erase.',
    object({
      suggestionId: curatorId('The suggestion id.'),
      action: literals(['merge', 'fold', 'replace', 'dispute', 'keep', 'unname'], 'What to do.'),
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

function registerDecide(pi: CuratorPiApi, client: BrainCuratorClient): void {
  registerWrite<BrainDecideRead>(
    pi,
    'brain_decide_read',
    'Brain: decide a read',
    'Approve or reject a read from brain_read_review, at the revision you read. Reject (approve: false) a read of a lane Brain never reads, or one with nothing worth keeping. Approving saves every memory that is not held, on every page of a long read, unless you list memories; read every page first, and answer required identity questions. Brain changes when you approve, so other reads may refresh before you open them.',
    object({
      jobId: curatorId('The read id.'),
      revision: Type.Integer({ minimum: 0, description: 'The revision brain_read_review showed.' }),
      approve: Type.Boolean({ description: 'true saves the read; false rejects all of it.' }),
      memories: indexes(
        'Memory indexes to save, from any page. Default: every memory that is not held, on every page.',
      ),
      identities: Type.Optional(
        Type.Array(
          object({
            ref: Type.String({
              minLength: 1,
              maxLength: 64,
              description: 'Identity ref, such as e1.',
            }),
            answer: Type.String({
              minLength: 1,
              maxLength: 200,
              description: 'An existing entity id, or "new".',
            }),
          }),
          {
            maxItems: 400,
            description: 'Answers to identity questions. Unanswered ones keep Brain’s decision.',
          },
        ),
      ),
      groups: indexes('Group question indexes you confirm.'),
      descriptions: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
          maxItems: 400,
          description:
            'Identity refs whose description from this read should replace the stored one.',
        }),
      ),
      confirmations: indexes(
        'Held "said again" indexes to save. The others save with any approval.',
      ),
      reason,
    }),
    // Brain builds the decision from the stored read, which can be larger than a bridge frame.
    async (params, signal) => client.call('decideRead', params, signal),
  )
}

function registerEdit(pi: CuratorPiApi, client: BrainCuratorClient): void {
  registerWrite<EditParams>(
    pi,
    'brain_edit',
    'Brain: edit a person or thing',
    'Edit people and things directly. merge folds sourceId into targetId. describe sets a short description (≤160 characters) that tells it apart. split moves memoryIds off entityId into a new record named label of kind entityKind. removeName removes one name from entityId.',
    object({
      kind: literals(['merge', 'describe', 'split', 'removeName'], 'The edit.'),
      sourceId: Type.Optional(curatorId('merge: the record merged away.')),
      targetId: Type.Optional(curatorId('merge: the record kept.')),
      entityId: Type.Optional(curatorId('describe, split, removeName: the record.')),
      description: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
      memoryIds: Type.Optional(
        Type.Array(curatorId('A memory id.'), { minItems: 1, maxItems: 200 }),
      ),
      label: Type.Optional(
        Type.String({ minLength: 1, maxLength: 80, description: 'split: the new record’s name.' }),
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
  registerWrite<{
    memoryId: string
    summary: string
    source: string
    quote: string
    reason: string
  }>(
    pi,
    'brain_correct',
    'Brain: correct a memory',
    'Replace a memory with a corrected one when a source (Linear, Notion, Slack, GitHub) states the new truth. summary is the corrected self-contained sentence; quote is the exact words from the source; source names it, such as "Linear KES-12" or "Slack #ledger". Undo restores the old memory.',
    object({
      memoryId: curatorId('The memory to correct.'),
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
