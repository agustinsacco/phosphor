import {
  BRAIN_ASK_MAX,
  BRAIN_ENTITY_KINDS,
  BRAIN_MEMORY_STATES,
  BRAIN_MEMORY_TYPES,
  BRAIN_TELL_MAX,
  checkBrainReaderModel,
  type BrainAgentRun,
  type BrainAgentStatus,
  type BrainExtractionView,
  type BrainFindResult,
  type BrainJob,
  type BrainMemory,
  type BrainMemoryDetail,
  type BrainMemoryPage,
  type BrainMemoryFilter,
  type BrainPrefs,
  type BrainStatus,
} from './brain'
import type { BrainAccess } from './brain-access'
import type { BrainRecall, BrainRoutes } from './brain-recall'
import type { BrainInvokeMap } from './ipc/brain'
import { isUuid } from './control-api'
import { record } from './host-protocol/primitives'
import type { ExtensionUIRequest, ExtensionUIResponse } from './rpc'
import { parseExtensionUiResponse } from './host-protocol/client-content'

export const BRAIN_SURFACE = 'brain.surface'
export const BRAIN_APPROVAL = 'brain.approval'
export function isBrainSurfaceOp(op: unknown): boolean {
  return op === BRAIN_SURFACE || op === BRAIN_APPROVAL
}
export type HostBrainJob = Omit<BrainJob, 'sessionPath' | 'scope' | 'model' | 'usage'>
export interface HostBrainStatus extends Omit<BrainStatus, 'agent' | 'jobs'> {
  jobs: HostBrainJob[]
  agent: Omit<BrainAgentStatus, 'folder' | 'run'> & {
    run: Omit<BrainAgentRun, 'sessionPath'> | null
  }
}
export type HostBrainMemory = Omit<BrainMemory, 'scope'>
export type HostBrainMemoryDetail = Omit<
  BrainMemoryDetail,
  'memory' | 'history' | 'related' | 'sourcePath'
> & {
  sourceLaneId: string | null
  memory: HostBrainMemory
  history: HostBrainMemory[]
  related: (Omit<BrainMemoryDetail['related'][number], 'memory'> & { memory: HostBrainMemory })[]
}
export type HostBrainExtraction = Pick<
  BrainExtractionView,
  'jobId' | 'title' | 'startedAt' | 'finishedAt' | 'outcomes' | 'memories'
> & {
  sourceLaneId: string | null
  job: HostBrainJob | null
  next?: number | null
  source: { exists: boolean; segments: BrainExtractionView['source']['segments'] }
}
export interface HostBrainLanePage {
  /** Host-issued cursor; never a path or a body containing a path. */
  next: string | null
  entries: { id: string; role: 'user' | 'assistant'; text: string }[]
  dialogs: ExtensionUIRequest[]
  fence: number
  controller: { self: boolean; label: string } | null
  running: boolean
  /** The running turn this caller may stop, as an opaque reference; null when none is theirs. */
  turn: string | null
  /** Whether this Host can run a person's message to Brain Agent at all. */
  messaging: boolean
}
export interface HostBrainLaneState {
  excluded: boolean
  activeJob: { id: string; state: 'waiting' | 'queued' | 'running' } | null
  lastRead: { jobId: string; memories: number; replaceable: number } | null
}
export type HostBrainMemoryFilter = Omit<BrainMemoryFilter, 'sessionId'> & { laneId?: string }
type Entry<A extends unknown[], R> = { args: A; result: R }
type StatusMethod = {
  [K in keyof BrainInvokeMap]: BrainInvokeMap[K]['result'] extends BrainStatus ? K : never
}[keyof BrainInvokeMap]
type StatusResult<K extends StatusMethod> = HostBrainStatus &
  Omit<BrainInvokeMap[K]['result'], keyof BrainStatus>
export type HostBrainMap = Omit<
  BrainInvokeMap,
  | StatusMethod
  | 'brain:tell'
  | 'brain:extraction'
  | 'brain:laneRead'
  | 'brain:ask'
  | 'brain:find'
  | 'brain:entityMemories'
  | 'brain:memory'
  | 'brain:path'
> & {
  [K in Exclude<StatusMethod, 'brain:queue'>]: Entry<BrainInvokeMap[K]['args'], StatusResult<K>>
} & {
  'brain:prefs': Entry<[], BrainPrefs>
  'brain:queue': Entry<[laneId: string], HostBrainStatus>
  'brain:tell': Entry<[message: string], null>
  'brain:laneState': Entry<[laneId: string], HostBrainLaneState>
  'brain:laneRead': Entry<
    [laneId: string],
    { job: HostBrainJob; memories: number; replaceable: number } | null
  >
  'brain:extraction': Entry<[jobId: string, offset?: number], HostBrainExtraction>
  'brain:ask': Entry<
    [question: string],
    Omit<BrainRecall, 'hits'> & {
      hits: (Omit<BrainRecall['hits'][number], 'memory'> & { memory: HostBrainMemory })[]
    }
  >
  'brain:find': Entry<
    BrainInvokeMap['brain:find']['args'],
    Omit<BrainFindResult, 'memories'> & { memories: HostBrainMemory[] }
  >
  'brain:entityMemories': Entry<
    [entityId: string, filter: HostBrainMemoryFilter, cursor: string | null],
    Omit<BrainMemoryPage, 'memories'> & { memories: HostBrainMemory[] }
  >
  'brain:memory': Entry<[memoryId: string], HostBrainMemoryDetail>
  'brain:path': Entry<
    BrainInvokeMap['brain:path']['args'],
    Omit<BrainRoutes, 'memories'> & { memories: HostBrainMemory[] }
  >
  'brain:laneShow': Entry<[cursor?: string | null], HostBrainLanePage>
  'brain:laneWatch': Entry<[cursor?: string | null], HostBrainLanePage>
  'brain:laneSend': Entry<[message: string, fence: number], null>
  'brain:laneStop': Entry<[fence: number, turn: string], null>
  'brain:laneAnswer': Entry<[answer: ExtensionUIResponse, fence: number], null>
  'brain:laneTake': Entry<[fence: number], null>
}
export type HostBrainMethod = keyof HostBrainMap

export const BRAIN_METHODS = {
  'brain:status': ['read', false],
  'brain:prefs': ['configure', false],
  'brain:setPrefs': ['configure', true],
  'brain:download': ['configure', true],
  'brain:removeModel': ['configure', true],
  'brain:reset': ['configure', true],
  'brain:queue': ['configure', true],
  'brain:cancel': ['configure', true],
  'brain:retry': ['configure', true],
  'brain:reread': ['configure', true],
  'brain:neverRead': ['configure', true],
  'brain:laneRead': ['read', false],
  'brain:laneState': ['read', false],
  'brain:extraction': ['evidence', false],
  'brain:tidyChanges': ['read', false],
  'brain:tidyUndo': ['configure', true],
  'brain:defrag': ['configure', true],
  'brain:defragStop': ['configure', true],
  'brain:undoRun': ['configure', true],
  'brain:ask': ['read', false],
  'brain:tell': ['control', true],
  'brain:setOwner': ['configure', true],
  'brain:merge': ['configure', true],
  'brain:describe': ['configure', true],
  'brain:removeName': ['configure', true],
  'brain:split': ['configure', true],
  'brain:find': ['read', false],
  'brain:overview': ['read', false],
  'brain:neighbourhood': ['read', false],
  'brain:entity': ['read', false],
  'brain:entityMemories': ['read', false],
  'brain:memory': ['evidence', false],
  'brain:path': ['read', false],
  'brain:forget': ['configure', true],
  'brain:laneShow': ['control', false],
  'brain:laneWatch': ['control', false],
  'brain:laneSend': ['control', true],
  'brain:laneStop': ['control', true],
  'brain:laneAnswer': ['control', true],
  'brain:laneTake': ['control', true],
} as const satisfies Record<HostBrainMethod, readonly [BrainAccess, boolean]>

export function isHostBrainMethod(value: unknown): value is HostBrainMethod {
  return typeof value === 'string' && Object.hasOwn(BRAIN_METHODS, value)
}

const bounded = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0')
const ref = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v)
const cursor = (v: unknown) =>
  v === null || (typeof v === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(v))
const uint = (v: unknown, max = Number.MAX_SAFE_INTEGER) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max
const list = (v: unknown, max: number, check: (item: unknown) => boolean) =>
  Array.isArray(v) && v.length <= max && v.every(check) && new Set(v).size === v.length
const only = (v: Record<string, unknown>, fields: readonly string[]) =>
  Object.keys(v).every((key) => fields.includes(key))

function prefs(v: unknown): v is BrainPrefs {
  if (
    !record(v) ||
    !only(v, ['enabled', 'recall', 'agentAuto', 'model', 'neverRead']) ||
    !record(v.neverRead) ||
    !only(v.neverRead, ['titles', 'sessionIds'])
  )
    return false
  try {
    checkBrainReaderModel(v.model)
  } catch {
    return false
  }
  return (
    typeof v.enabled === 'boolean' &&
    typeof v.recall === 'boolean' &&
    typeof v.agentAuto === 'boolean' &&
    list(v.neverRead.titles, 100, (item) => bounded(item, 120)) &&
    Array.isArray(v.neverRead.sessionIds) &&
    v.neverRead.sessionIds.length === 0
  )
}

function filter(v: unknown): boolean {
  return (
    record(v) &&
    only(v, ['types', 'states', 'laneId']) &&
    (v.types === undefined || list(v.types, 6, (x) => BRAIN_MEMORY_TYPES.some((k) => k === x))) &&
    (v.states === undefined ||
      list(v.states, 3, (x) => BRAIN_MEMORY_STATES.some((k) => k === x))) &&
    (v.laneId === undefined || isUuid(v.laneId))
  )
}

export function parseHostBrainArgs<K extends HostBrainMethod>(
  method: K,
  value: unknown,
): HostBrainMap[K]['args'] | null {
  if (!Array.isArray(value)) return null
  const checked = basicArgs(method, value) ?? knowledgeArgs(method, value)
  return checked ? (value as HostBrainMap[K]['args']) : null
}

function basicArgs(method: HostBrainMethod, value: readonly unknown[]): boolean | undefined {
  const [a, b] = value
  const n = value.length
  switch (method) {
    case 'brain:overview':
    case 'brain:status':
    case 'brain:prefs':
    case 'brain:defrag':
    case 'brain:defragStop':
    case 'brain:download':
    case 'brain:removeModel':
    case 'brain:reset':
      return n === 0
    case 'brain:setPrefs':
      return n === 1 && prefs(a)
    case 'brain:laneRead':
    case 'brain:laneState':
    case 'brain:queue':
      return n === 1 && isUuid(a)
    case 'brain:neverRead':
      return n === 2 && isUuid(a) && typeof b === 'boolean'
    case 'brain:undoRun':
    case 'brain:reread':
    case 'brain:cancel':
    case 'brain:retry':
    case 'brain:entity':
    case 'brain:memory':
    case 'brain:forget':
      return n === 1 && ref(a)
    case 'brain:setOwner':
      return n === 1 && (a === null || ref(a))
    case 'brain:extraction':
      return ref(a) && (n === 1 || (n === 2 && uint(b, 10000)))
    case 'brain:tidyChanges':
      return n === 1 && uint(a, 100) && a !== 0
    case 'brain:tidyUndo':
      return n === 2 && ref(a) && uint(b)
    default:
      return undefined
  }
}

function knowledgeArgs(method: HostBrainMethod, value: readonly unknown[]): boolean {
  const [a, b, c, d] = value
  const n = value.length
  switch (method) {
    case 'brain:ask':
      return n === 1 && bounded(a, BRAIN_ASK_MAX)
    case 'brain:tell':
      return n === 1 && bounded(a, BRAIN_TELL_MAX)
    case 'brain:find':
      return n === 2 && bounded(a, BRAIN_ASK_MAX) && uint(b, 50) && b !== 0
    case 'brain:merge':
      return n === 3 && ref(a) && ref(b) && a !== b && uint(c)
    case 'brain:path':
      return n === 2 && ref(a) && ref(b)
    case 'brain:describe':
    case 'brain:removeName':
      return n === 3 && ref(a) && bounded(b, 160) && uint(c)
    case 'brain:split':
      return (
        n === 4 &&
        ref(a) &&
        list(b, 200, ref) &&
        Array.isArray(b) &&
        b.length > 0 &&
        record(c) &&
        only(c, ['label', 'kind']) &&
        bounded(c.label, 160) &&
        BRAIN_ENTITY_KINDS.some((k) => k === c.kind) &&
        uint(d)
      )
    case 'brain:neighbourhood':
      return n === 2 && ref(a) && (b === 1 || b === 2)
    case 'brain:entityMemories':
      return n === 3 && ref(a) && filter(b) && cursor(c)
    case 'brain:laneShow':
    case 'brain:laneWatch':
      return n === 0 || (n === 1 && cursor(a))
    case 'brain:laneSend':
      return n === 2 && bounded(a, BRAIN_TELL_MAX) && uint(b)
    case 'brain:laneStop':
      return n === 2 && uint(a) && ref(b)
    case 'brain:laneTake':
      return n === 1 && uint(a)
    case 'brain:laneAnswer': {
      const answer = parseExtensionUiResponse(a)
      return (
        n === 2 &&
        record(a) &&
        Object.keys(a).length === 3 &&
        answer !== null &&
        (!('value' in answer) ||
          (answer.value.length <= BRAIN_TELL_MAX && !answer.value.includes('\0'))) &&
        uint(b)
      )
    }
    default:
      return false
  }
}
