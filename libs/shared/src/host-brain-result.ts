import { isUuid } from './control-api'
/** Only reviewed structured fields cross the wire. Arrays and prose are capped at the boundary. */
import { record } from './host-protocol/primitives'
import type { HostBrainMap, HostBrainMethod } from './host-brain'

type Shape = (value: unknown) => unknown
const array =
  (item: Shape, cap = 200): Shape =>
  (v) => {
    if (!Array.isArray(v)) throw new Error('array')
    return v.slice(0, cap).map(item)
  }
const object =
  (fields: Readonly<Record<string, Shape>>): Shape =>
  (v) => {
    if (!record(v)) throw new Error('object')
    return Object.fromEntries(Object.entries(fields).map(([key, shape]) => [key, shape(v[key])]))
  }
const nullable =
  (item: Shape): Shape =>
  (v) =>
    v === null ? null : item(v)
const optional =
  (item: Shape): Shape =>
  (v) =>
    v === undefined ? undefined : item(v)
const text = (v: unknown) => {
  if (typeof v !== 'string') throw new Error('text')
  return v.slice(0, 8192)
}
const ref = (v: unknown) => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(v)) throw new Error('id')
  return v
}
const num = (v: unknown) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('number')
  return v
}
const bool = (v: unknown) => {
  if (typeof v !== 'boolean') throw new Error('boolean')
  return v
}
const oneOf =
  (...options: string[]): Shape =>
  (v) => {
    if (!options.some((option) => option === v)) throw new Error('enum')
    return v
  }
const nullOnly: Shape = (v) => {
  if (v !== null) throw new Error('null')
  return null
}
const sourceLaneId: Shape = (v) => (v === undefined || v === null ? null : isUuid(v) ? v : null)
const ids = array(ref)
const count = nullable(num)
const note = nullable(text)
const id = nullable(ref)
// Operational errors can contain stderr, argv, paths and provider credentials.
const problem: Shape = (v) => (v == null ? null : 'Brain could not complete this operation.')
const model: Shape = (v) => {
  if (
    typeof v !== 'string' ||
    !/^[a-zA-Z0-9_.:@-]+(?:\/[a-zA-Z0-9_.:@-]+)*$/.test(v) ||
    v.split('/').some((part) => part === '.' || part === '..')
  )
    throw new Error('model')
  return v
}
const originFields = { sessionId: ref, title: text }
const prefs = object({
  enabled: bool,
  recall: bool,
  agentAuto: bool,
  model: nullable(model),
  neverRead: object({ titles: array(text, 100), sessionIds: () => [] }),
})
const job = object({
  id: ref,
  replaces: id,
  sessionId: ref,
  title: text,
  branch: note,
  state: text,
  memories: num,
  leafId: id,
  error: problem,
  queuedAt: num,
  startedAt: count,
  runStartedAt: count,
  fromLeafId: id,
  finishedAt: count,
  progress: nullable(object({ stage: text, done: num, total: num })),
})
const statusFields = {
  prefs: (v: unknown) => prefs(record(v) ? { ...v, model: null } : v),
  generation: ref,
  revision: num,
  ownerId: id,
  supported: bool,
  counts: object({ memories: num, entities: num }),
  readSessionIds: () => [],
  jobs: array(job, 150),
  tidy: object({ automaticFolds: num, newestAutomaticFoldAt: count }),
  embedding: object({
    phase: text,
    receivedBytes: num,
    totalBytes: num,
    error: optional((v) => problem(v) ?? undefined),
    modelId: model,
    dimensions: num,
  }),
  agent: object({
    waiting: object({
      entities: num,
      groups: num,
      unlinked: num,
      repeats: num,
      conflicts: num,
      flags: num,
    }),
    run: nullable(
      object({
        id: ref,
        state: text,
        total: num,
        decided: num,
        erased: num,
        undoable: num,
        queuedAt: num,
        startedAt: count,
        finishedAt: count,
        error: problem,
        rulesChanged: bool,
        automatic: bool,
      }),
    ),
  }),
}
const status = object(statusFields)
const mutation = object({ ...statusFields, operationId: id })
const link = object({
  id: ref,
  subjectId: ref,
  predicate: text,
  objectId: ref,
  memoryId: ref,
  label: text,
  validFrom: count,
  validTo: count,
  statedBy: text,
})
const entityFields = {
  id: ref,
  label: text,
  kind: text,
  aliases: array(text, 50),
  description: text,
}
const entity = object(entityFields)
const entitySummary = object({ ...entityFields, memories: num, connections: num })
const memory = object({
  id: ref,
  jobId: id,
  summary: text,
  type: text,
  kind: text,
  state: text,
  entityIds: ids,
  links: array(link, 50),
  branch: note,
  validFrom: count,
  validTo: count,
  recordedAt: num,
  observedAt: num,
  origin: nullable(object(originFields)),
  importance: num,
  saidBy: text,
  lanes: num,
})
const graph = object({
  nodes: array(entitySummary, 250),
  links: array(link, 500),
  ended: array(link),
  centerId: id,
  truncated: bool,
})
const connection = object({ entity: entitySummary, link, supports: num })
const quote = object({ quote: text, before: text, after: text, label: text })
const linkQuotes: Shape = (v) => {
  if (!record(v)) throw new Error('link quotes')
  return Object.fromEntries(
    Object.entries(v)
      .slice(0, 50)
      .map(([key, value]) => [ref(key), array(quote, 10)(value)]),
  )
}
const memoryDetail = object({
  sourceLaneId,
  memory,
  quotes: array(quote, 20),
  linkQuotes,
  entities: array(entity),
  history: array(memory, 30),
  related: array(object({ kind: text, memory }), 30),
  use: object({ recalled: num, lastRecalledAt: count, flagged: num }),
})
const entityView = object({
  entity: entitySummary,
  sources: array(object({ ...originFields, memories: num })),
  lastLearnedAt: count,
  groups: array(
    object({
      predicate: text,
      direction: text,
      total: num,
      items: array(connection, 50),
      next: id,
    }),
    28,
  ),
  ended: array(connection, 20),
  together: array(object({ entity: entitySummary, shared: num }), 12),
  togetherMore: num,
  memoryCounts: object({
    decision: num,
    open: num,
    risk: num,
    procedure: num,
    preference: num,
    fact: num,
  }),
  merged: array(text, 50),
})
const changes = object({
  revision: num,
  items: array(
    object({
      id: ref,
      kind: text,
      who: text,
      reason: note,
      runId: id,
      jobId: id,
      undoable: bool,
      summary: text,
      createdAt: num,
      undoneAt: count,
      suggestionId: id,
    }),
    100,
  ),
})
const recall = object({
  mode: oneOf('search'),
  status: text,
  hits: array(
    object({
      memory,
      score: num,
      reasons: array(text, 4),
      trail: nullable(object({ seedId: ref, links: array(link, 2), entityId: ref })),
    }),
    8,
  ),
  entities: array(entity),
  focus: ids,
  more: num,
  branch: note,
  degradation: array(text, 8),
})
const routeStep: Shape = (v) =>
  record(v) && v.kind === 'relation'
    ? object({ kind: oneOf('relation'), link })(v)
    : object({ kind: oneOf('together'), fromId: ref, toId: ref, memoryId: ref, shared: num })(v)
const routes = object({
  mode: oneOf('route'),
  status: text,
  from: nullable(entity),
  to: nullable(entity),
  routes: array(array(routeStep, 4), 3),
  memories: array(memory, 12),
  entities: array(entity, 50),
})
const extraction = object({
  sourceLaneId,
  jobId: ref,
  title: text,
  startedAt: num,
  finishedAt: num,
  outcomes: array(
    object({
      candidate: text,
      summary: text,
      status: text,
      proposalIndex: optional(num),
      memoryId: optional(ref),
      removed: optional(bool),
      reason: optional(text),
    }),
    200,
  ),
  memories: array(object({ id: ref, summary: text })),
  job: nullable(job),
  source: object({
    exists: bool,
    segments: array(object({ entryId: ref, role: text, label: text, observedAt: num, text }), 24),
  }),
  next: optional(count),
})
const dialog: Shape = (v) => {
  if (!record(v)) throw new Error('dialog')
  const base = { type: oneOf('extension_ui_request'), id: ref, title: text, timeout: optional(num) }
  switch (v.method) {
    case 'select':
      return object({ ...base, method: oneOf('select'), options: array(text, 64) })(v)
    case 'confirm':
      return object({ ...base, method: oneOf('confirm'), message: text })(v)
    case 'input':
      return object({ ...base, method: oneOf('input'), placeholder: optional(text) })(v)
    case 'editor':
      return object({ ...base, method: oneOf('editor'), prefill: optional(text) })(v)
    default:
      throw new Error('dialog method')
  }
}
const lane = object({
  next: id,
  entries: array(object({ id: ref, role: oneOf('user', 'assistant'), text }), 40),
  dialogs: array(dialog, 16),
  fence: num,
  controller: nullable(object({ self: bool, label: text })),
  running: bool,
  turn: nullable(ref),
  messaging: bool,
})

const SHAPES = {
  'brain:status': status,
  'brain:prefs': prefs,
  'brain:setPrefs': status,
  'brain:download': status,
  'brain:removeModel': status,
  'brain:reset': status,
  'brain:queue': status,
  'brain:cancel': status,
  'brain:retry': status,
  'brain:reread': status,
  'brain:neverRead': status,
  'brain:tidyUndo': status,
  'brain:defrag': status,
  'brain:defragStop': status,
  'brain:setOwner': status,
  'brain:forget': status,
  'brain:undoRun': object({ ...statusFields, undone: num, kept: num }),
  'brain:laneState': object({
    excluded: bool,
    activeJob: nullable(object({ id: ref, state: oneOf('waiting', 'queued', 'running') })),
    lastRead: nullable(object({ jobId: ref, memories: num, replaceable: num })),
  }),
  'brain:laneRead': nullable(object({ job, memories: num, replaceable: num })),
  'brain:extraction': extraction,
  'brain:tidyChanges': changes,
  'brain:ask': recall,
  'brain:tell': nullOnly,
  'brain:merge': mutation,
  'brain:describe': mutation,
  'brain:removeName': mutation,
  'brain:split': mutation,
  'brain:overview': graph,
  'brain:neighbourhood': graph,
  'brain:entity': entityView,
  'brain:find': object({
    entities: array(entitySummary, 50),
    memories: array(memory, 50),
    referenced: array(entity),
    degradation: array(text, 8),
  }),
  'brain:entityMemories': object({ memories: array(memory), entities: array(entity), next: id }),
  'brain:memory': memoryDetail,
  'brain:path': routes,
  'brain:laneShow': lane,
  'brain:laneWatch': lane,
  'brain:laneSend': nullOnly,
  'brain:laneStop': nullOnly,
  'brain:laneAnswer': nullOnly,
  'brain:laneTake': nullOnly,
} satisfies Record<HostBrainMethod, Shape>

export function projectHostBrainResult<K extends HostBrainMethod>(
  method: K,
  value: unknown,
): { value: HostBrainMap[K]['result'] } | null {
  try {
    return { value: SHAPES[method](value) as HostBrainMap[K]['result'] }
  } catch {
    return null
  }
}
