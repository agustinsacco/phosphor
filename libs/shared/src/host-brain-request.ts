import { BRAIN_ACCESS, type BrainAccess } from './brain-access'
import { isUuid } from './control-api'
import { record } from './host-protocol/primitives'
import {
  type HostBrainMap,
  BRAIN_METHODS,
  type HostBrainMethod,
  isHostBrainMethod,
  parseHostBrainArgs,
} from './host-brain'

export interface HostBrainVersion {
  generation: string
  revision: number
}

const VERSION_MODE = {
  'brain:setPrefs': 'revision',
  'brain:download': 'revision',
  'brain:removeModel': 'revision',
  'brain:reset': 'revision',
  'brain:queue': 'generation',
  'brain:cancel': 'generation',
  'brain:retry': 'generation',
  'brain:reread': 'generation',
  'brain:neverRead': 'revision',
  'brain:tidyUndo': 1,
  'brain:undoRun': 'revision',
  'brain:setOwner': 'revision',
  'brain:merge': 2,
  'brain:describe': 2,
  'brain:removeName': 2,
  'brain:split': 3,
  'brain:forget': 'revision',
} as const satisfies Partial<Record<HostBrainMethod, 'generation' | 'revision' | number>>

type Guarded = keyof typeof VERSION_MODE
export type HostBrainRequest<K extends HostBrainMethod = HostBrainMethod> =
  K extends HostBrainMethod
    ? {
        method: K
        args: HostBrainMap[K]['args']
      } & (K extends Guarded ? { expected: HostBrainVersion } : { expected?: never })
    : never

export function brainVersionMode(method: HostBrainMethod): 'generation' | 'revision' | undefined {
  if (!Object.hasOwn(VERSION_MODE, method)) return undefined
  return VERSION_MODE[method as Guarded] === 'generation' ? 'generation' : 'revision'
}

export function parseHostBrainRequest(value: unknown): HostBrainRequest | null {
  if (!record(value) || !isHostBrainMethod(value.method)) return null
  const { method, expected } = value
  const args = parseHostBrainArgs(method, value.args)
  const guarded = brainVersionMode(method) !== undefined
  if (!args || Object.keys(value).length !== (guarded ? 3 : 2)) return null
  if (!guarded) return expected === undefined ? ({ method, args } as HostBrainRequest) : null
  if (
    !record(expected) ||
    Object.keys(expected).length !== 2 ||
    !isUuid(expected.generation) ||
    typeof expected.revision !== 'number' ||
    !Number.isSafeInteger(expected.revision) ||
    expected.revision < 0
  )
    return null
  const position = VERSION_MODE[method as Guarded]
  if (typeof position === 'number' && args[position] !== expected.revision) return null
  return {
    method,
    args,
    expected: { generation: expected.generation, revision: expected.revision },
  } as HostBrainRequest
}

/**
 * Brain Agent's conversation shows what the agent read (evidence included) and drives changes
 * it makes to knowledge, so seeing or driving it takes every Brain right. Stop alone ends the
 * running turn and returns nothing, so it takes control only.
 */
const BRAIN_CONVERSATION_METHODS = new Set<HostBrainMethod>([
  'brain:laneShow',
  'brain:laneWatch',
  'brain:laneSend',
  'brain:laneTake',
  'brain:laneAnswer',
  'brain:tell',
])

/** Methods that act on Brain Agent's lane; a grant user also needs `sessions.control` for them. */
export function brainActsOnAgentLane(method: HostBrainMethod): boolean {
  return BRAIN_CONVERSATION_METHODS.has(method) || method === 'brain:laneStop'
}

/**
 * Whether a client holding `access` and `capabilities` should offer `method`. The Host decides
 * again on every call; this only keeps clients from offering what the Host refuses.
 */
export function brainClientMayInvoke(
  method: HostBrainMethod,
  access: readonly BrainAccess[],
  capabilities: readonly string[],
): boolean {
  return (
    brainRequiredAccess(method).every((right) => access.includes(right)) &&
    (!brainActsOnAgentLane(method) || capabilities.includes('sessions.control'))
  )
}

export function brainRequiredAccess(method: HostBrainMethod): readonly BrainAccess[] {
  if (BRAIN_CONVERSATION_METHODS.has(method)) return BRAIN_ACCESS
  // Configuration changes return a status projection; evidence is a separate privilege.
  const [access] = BRAIN_METHODS[method]
  return access === 'configure' || access === 'evidence' ? (['read', access] as const) : [access]
}
