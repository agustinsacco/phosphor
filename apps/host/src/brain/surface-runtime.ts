import {
  BRAIN_EMBEDDING_MODEL,
  DEFAULT_BRAIN_PREFS,
  type BrainPrefs,
  type BrainStatus,
} from '@phosphor/shared/brain'
import { emptyBrainTidySummary } from '@phosphor/shared/brain-tidy'
import { BRAIN_METHODS, type HostBrainMethod } from '@phosphor/shared/host-brain'
import type { HostBrainRequest } from '@phosphor/shared/host-brain-request'
import type {
  BrainSurfaceAuthority,
  BrainSurfaceHandlers,
  BrainSurfaceOutcome,
} from '../api/brain-adapter'
import type { GuardedBrainService, HostBrain } from './runtime'
import {
  createBrainSurfaceHandlers,
  type BrainSurfaceAgent,
  type BrainSurfaceInventory,
} from './surface-service'

/**
 * The generation a Host without a Brain store reports. Enabling quotes it, so a stale enable
 * (made against another Host, or after this one already created its store) cannot apply.
 */
export const HOST_BRAIN_OFF_GENERATION = '00000000-0000-4000-8000-000000000000'

export interface HostBrainSurfacePorts {
  brain: Pick<HostBrain, 'state' | 'service' | 'open'>
  lanes: BrainSurfaceInventory
  /** Brain Agent's lane, from its owner; absent: its methods answer unavailable. */
  agent(): BrainSurfaceAgent | undefined
  /** Whether a store may be created now: false while a move or Desktop's Brain owns it. */
  mayCreate(): boolean
  /** The embedding runtime runs on this platform. */
  supported: boolean
}

const OFF_PREFS: BrainPrefs = { ...DEFAULT_BRAIN_PREFS, enabled: false }

/** What a Host with no Brain store shows: off, empty, nothing created to say so. */
function offStatus(supported: boolean): BrainStatus {
  return {
    prefs: OFF_PREFS,
    revision: 0,
    generation: HOST_BRAIN_OFF_GENERATION,
    counts: { memories: 0, entities: 0 },
    readSessionIds: [],
    jobs: [],
    ownerId: null,
    tidy: emptyBrainTidySummary(),
    agent: {
      waiting: { entities: 0, groups: 0, unlinked: 0, repeats: 0, conflicts: 0, flags: 0 },
      run: null,
      folder: null,
    },
    supported,
    embedding: {
      phase: supported ? 'missing' : 'unsupported',
      receivedBytes: 0,
      totalBytes: BRAIN_EMBEDDING_MODEL.downloadBytes,
      modelId: BRAIN_EMBEDDING_MODEL.id,
      dimensions: BRAIN_EMBEDDING_MODEL.dimensions,
    },
  }
}

const unavailable: BrainSurfaceOutcome = { status: 'unavailable' }

/** Brain Agent's methods through whatever lane its owner supplies now. */
function lateAgent(agent: () => BrainSurfaceAgent | undefined): BrainSurfaceAgent {
  const none = () => {
    throw new Error('Brain Agent is unavailable on this Host.')
  }
  return {
    show: async (...args) => (agent() ?? none()).show(...args),
    watch: async (...args) => (agent() ?? none()).watch(...args),
    tell: async (...args) => agent()?.tell(...args) ?? 'unavailable',
    send: async (...args) => agent()?.send(...args) ?? 'unavailable',
    take: async (...args) => agent()?.take(...args) ?? 'unavailable',
    stop: async (...args) => agent()?.stop(...args) ?? 'unavailable',
    answer: async (...args) => agent()?.answer(...args) ?? 'unavailable',
  }
}

/**
 * The Host's Brain surface, for the one binding the socket and TCP API share. A Host with no
 * store shows its owner status and preferences and accepts one thing: turning Brain on, which
 * creates the store. A Brain the Host does not own now (a move, a stop) answers unavailable.
 */
export function createHostBrainSurfaceHandlers(ports: HostBrainSurfacePorts): BrainSurfaceHandlers {
  const agent = lateAgent(ports.agent)
  let bound: { service: GuardedBrainService; handlers: BrainSurfaceHandlers } | undefined
  let creating = false
  const handlersFor = (service: GuardedBrainService) => {
    if (bound?.service !== service)
      bound = {
        service,
        handlers: createBrainSurfaceHandlers({ runtime: service, lanes: ports.lanes, agent }),
      }
    return bound.handlers
  }

  async function create(
    request: HostBrainRequest<'brain:setPrefs'>,
    caller: BrainSurfaceAuthority,
  ): Promise<BrainSurfaceOutcome> {
    const [prefs] = request.args
    if (!prefs.enabled) return { status: 'disabled' }
    if (
      creating ||
      request.expected.generation !== HOST_BRAIN_OFF_GENERATION ||
      request.expected.revision !== 0
    )
      return { status: 'stale' }
    if (!caller.admit() || !ports.mayCreate()) return unavailable
    creating = true
    try {
      const service = await ports.brain.open()
      const writer = service.guarded(() => {
        if (!caller.admit() || !ports.mayCreate()) throw new Error('Brain ownership changed.')
      })
      return { status: 'ok', data: await writer.setPrefs(prefs) }
    } catch {
      return unavailable
    } finally {
      creating = false
    }
  }

  function off(request: HostBrainRequest, caller: BrainSurfaceAuthority): BrainSurfaceOutcome {
    if (!caller.admit()) return unavailable
    if (request.method === 'brain:status') return { status: 'ok', data: offStatus(ports.supported) }
    if (request.method === 'brain:prefs') return { status: 'ok', data: OFF_PREFS }
    return { status: 'disabled' }
  }

  async function dispatch(
    request: HostBrainRequest,
    caller: BrainSurfaceAuthority,
  ): Promise<BrainSurfaceOutcome> {
    const state = ports.brain.state()
    if (state === 'off') {
      return request.method === 'brain:setPrefs'
        ? create(request as HostBrainRequest<'brain:setPrefs'>, caller)
        : off(request, caller)
    }
    if (state === 'refused' || state === 'closed') return unavailable
    let service: GuardedBrainService | undefined
    try {
      service = await ports.brain.service()
    } catch {
      return unavailable
    }
    if (!service) return unavailable
    const handler = handlersFor(service)[request.method] as (
      request: HostBrainRequest,
      caller: BrainSurfaceAuthority,
    ) => ReturnType<BrainSurfaceHandlers[HostBrainMethod]>
    return handler(request, caller)
  }

  return Object.fromEntries(
    (Object.keys(BRAIN_METHODS) as HostBrainMethod[]).map((method) => [method, dispatch]),
  ) as BrainSurfaceHandlers
}
