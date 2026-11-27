import type { BrainStatus } from '@phosphor/shared/brain'
import { BrainResetBusy } from '@phosphor/brain-runtime/api'
import type {
  BrainApi,
  BrainMutationCheck,
  BrainSavedSource,
  BrainSurfaceRuntime,
} from '@phosphor/brain-runtime/types'
import { checkCaller, LaneScope, refuse, Refused, visibleJobs } from './surface-sources'
import type {
  HostBrainLanePage,
  HostBrainLaneState,
  HostBrainMethod,
} from '@phosphor/shared/host-brain'
import { brainVersionMode, type HostBrainRequest } from '@phosphor/shared/host-brain-request'
import type { ExtensionUIResponse } from '@phosphor/shared/rpc'
import type {
  BrainSurfaceAuthority,
  BrainSurfaceHandlers,
  BrainSurfaceOutcome,
} from '../api/brain-adapter'

export interface BrainInventoryLane extends BrainSavedSource {
  readonly laneId: string
  readonly title: string
}

/** Only admitted, visible, same-Host lanes. The reserved agent must never resolve here. */
export interface BrainSurfaceInventory {
  lane(laneId: string, caller: BrainSurfaceAuthority): BrainInventoryLane | undefined
  source(source: BrainSavedSource, caller: BrainSurfaceAuthority): BrainInventoryLane | undefined
}

type AgentResult = 'ok' | 'stale' | 'not-controller' | 'unavailable' | 'busy' | 'not-found'
export type BrainAgentSurfacePage = Omit<HostBrainLanePage, 'controller'> & {
  controller: { clientId: string; label: string } | null
}
/** Bound to one reserved lane. The adapter rechecks live authority and the real fence at execution. */
export interface BrainSurfaceAgent {
  show(cursor: string | null, caller: BrainSurfaceAuthority): Promise<BrainAgentSurfacePage>
  watch(cursor: string | null, caller: BrainSurfaceAuthority): Promise<BrainAgentSurfacePage>
  tell(message: string, caller: BrainSurfaceAuthority): Promise<AgentResult>
  send(message: string, fence: number, caller: BrainSurfaceAuthority): Promise<AgentResult>
  take(fence: number, caller: BrainSurfaceAuthority): Promise<AgentResult>
  /** Stops the turn `turn` names, the one the caller saw on the page. */
  stop(fence: number, turn: string, caller: BrainSurfaceAuthority): Promise<AgentResult>
  answer(
    answer: ExtensionUIResponse,
    fence: number,
    caller: BrainSurfaceAuthority,
  ): Promise<AgentResult>
}
export interface BrainSurfacePorts {
  runtime: BrainSurfaceRuntime
  lanes: BrainSurfaceInventory
  agent: BrainSurfaceAgent
}

const ok = (data: unknown): BrainSurfaceOutcome => ({ status: 'ok', data })

/** Build an owner-local writer handle for this one request, not for the socket's lifetime. */
function writer(
  ports: BrainSurfacePorts,
  request: HostBrainRequest,
  caller: BrainSurfaceAuthority,
  lane?: BrainInventoryLane,
) {
  const mode = brainVersionMode(request.method)
  const check: BrainMutationCheck = (status, source) => {
    checkCaller(caller)
    if (
      mode &&
      (!request.expected ||
        status.generation !== request.expected.generation ||
        (mode === 'revision' && status.revision !== request.expected.revision))
    )
      refuse('stale')
    if (lane) new LaneScope(ports.lanes, caller).check(lane, source)
    if (!status.prefs.enabled && !OFF_WRITABLE.has(request.method)) refuse('disabled')
  }
  return ports.runtime.guarded(check)
}

const OFF_WRITABLE = new Set<HostBrainMethod>([
  'brain:setPrefs',
  'brain:removeModel',
  'brain:reset',
  'brain:neverRead',
  'brain:cancel',
  'brain:defragStop',
])

async function whileEnabled(api: BrainApi, caller: BrainSurfaceAuthority) {
  checkCaller(caller)
  if (!(await api.status()).prefs.enabled) refuse('disabled')
  checkCaller(caller)
}

async function laneState(
  api: BrainApi,
  sources: LaneScope,
  laneId: string,
): Promise<HostBrainLaneState> {
  const lane = sources.lane(laneId)
  const [status, last] = await Promise.all([api.status(), api.laneRead(lane.sessionId)])
  sources.check(lane)
  const active = status.jobs.find(
    (job) =>
      job.sessionId === lane.sessionId &&
      job.sessionPath === lane.sessionPath &&
      activeJob(job.state),
  )
  return {
    excluded: status.prefs.neverRead.sessionIds.includes(lane.sessionId),
    activeJob: active && activeJob(active.state) ? { id: active.id, state: active.state } : null,
    lastRead:
      last?.job.sessionPath === lane.sessionPath
        ? { jobId: last.job.id, memories: last.memories, replaceable: last.replaceable }
        : null,
  }
}

function activeJob(state: string): state is 'waiting' | 'queued' | 'running' {
  return state === 'waiting' || state === 'queued' || state === 'running'
}

async function run<T>(
  caller: BrainSurfaceAuthority,
  execute: () => Promise<T>,
): Promise<BrainSurfaceOutcome> {
  try {
    checkCaller(caller)
    const result = await execute()
    checkCaller(caller)
    return ok(result)
  } catch (error) {
    if (error instanceof Refused) return { status: error.status }
    if (error instanceof BrainResetBusy) return { status: 'busy' }
    return { status: 'unavailable' }
  }
}

async function extractionPage(
  ports: BrainSurfacePorts,
  caller: BrainSurfaceAuthority,
  id: string,
  offset: number,
) {
  const scopes = new LaneScope(ports.lanes, caller)
  const raw = await ports.runtime.evidence(id, (source) => scopes.source(source) !== undefined)
  const lane = scopes.source(raw)
  const start = Math.min(raw.source.segments.length, offset)
  const end = start + 24
  return {
    ...raw,
    title: lane ? lane.title || 'Untitled lane' : 'Unavailable lane',
    sourceLaneId: lane?.laneId ?? null,
    source: {
      exists: !!lane && raw.source.exists,
      segments: lane ? raw.source.segments.slice(start, end) : [],
    },
    next: lane && raw.source.segments.length > end ? end : null,
  }
}

function reads(ports: BrainSurfacePorts) {
  const { api } = ports.runtime
  const reading = <T>(caller: BrainSurfaceAuthority, task: () => Promise<T>) =>
    run(caller, async () => {
      await whileEnabled(api, caller)
      return task()
    })
  return {
    'brain:status': (_, c) =>
      run(c, async () => visibleJobs(await api.status(), new LaneScope(ports.lanes, c))),
    'brain:prefs': (_, c) => run(c, async () => (await api.status()).prefs),
    'brain:laneState': ({ args: [id] }, c) =>
      run(c, () => laneState(api, new LaneScope(ports.lanes, c), id)),
    'brain:laneRead': ({ args: [id] }, c) =>
      reading(c, async () => {
        const scopes = new LaneScope(ports.lanes, c)
        const lane = scopes.lane(id)
        const last = await api.laneRead(lane.sessionId)
        scopes.check(lane)
        return last?.job.sessionPath === lane.sessionPath
          ? { ...last, job: { ...last.job, title: lane.title || 'Untitled lane' } }
          : null
      }),
    'brain:tidyChanges': ({ args }, c) =>
      reading(c, async () => {
        const changes = await api.tidyChanges(...args)
        return {
          ...changes,
          items: changes.items.map((item) =>
            item.kind === 'read' ? { ...item, summary: 'Saved a lane read' } : item,
          ),
        }
      }),
    'brain:ask': ({ args }, c) => reading(c, () => api.ask(...args)),
    'brain:find': ({ args }, c) => reading(c, () => api.find(...args)),
    'brain:overview': (_, c) => reading(c, () => api.overview()),
    'brain:neighbourhood': ({ args }, c) => reading(c, () => api.neighbourhood(...args)),
    'brain:entity': ({ args }, c) => reading(c, () => api.entity(...args)),
    'brain:path': ({ args }, c) => reading(c, () => api.path(...args)),
    'brain:entityMemories': ({ args: [id, filter, cursor] }, c) =>
      reading(c, async () => {
        const { laneId, ...criteria } = filter
        const scopes = new LaneScope(ports.lanes, c)
        const lane = laneId === undefined ? undefined : scopes.lane(laneId)
        const found = await api.entityMemories(
          id,
          { ...criteria, ...(lane ? { sessionId: lane.sessionId } : {}) },
          cursor,
        )
        if (lane) scopes.check(lane)
        return found
      }),
    'brain:memory': ({ args: [id] }, c) =>
      reading(c, async () => {
        const detail = await api.memory(id)
        const origin = detail.memory.origin
        const lane =
          origin && detail.sourcePath
            ? new LaneScope(ports.lanes, c).source({
                sessionId: origin.sessionId,
                sessionPath: detail.sourcePath,
              })
            : undefined
        return { ...detail, sourceLaneId: lane?.laneId ?? null }
      }),
    'brain:extraction': ({ args: [id, offset = 0] }, c) =>
      reading(c, () => extractionPage(ports, c, id, offset)),
  } satisfies Pick<BrainSurfaceHandlers, ReadMethod>
}

type ReadMethod =
  | 'brain:status'
  | 'brain:prefs'
  | 'brain:laneState'
  | 'brain:laneRead'
  | 'brain:tidyChanges'
  | 'brain:ask'
  | 'brain:find'
  | 'brain:overview'
  | 'brain:neighbourhood'
  | 'brain:entity'
  | 'brain:path'
  | 'brain:entityMemories'
  | 'brain:memory'
  | 'brain:extraction'

function writes(ports: BrainSurfacePorts) {
  const write = <T extends BrainStatus>(
    request: HostBrainRequest,
    caller: BrainSurfaceAuthority,
    task: (api: ReturnType<BrainSurfaceRuntime['guarded']>) => Promise<T>,
  ) =>
    run(caller, async () =>
      visibleJobs(await task(writer(ports, request, caller)), new LaneScope(ports.lanes, caller)),
    )
  return {
    'brain:setPrefs': (r, c) => write(r, c, (a) => a.setPrefs(...r.args)),
    'brain:download': (r, c) => write(r, c, (a) => a.download()),
    'brain:removeModel': (r, c) => write(r, c, (a) => a.removeModel()),
    'brain:reset': (r, c) => write(r, c, (a) => a.reset()),
    'brain:cancel': (r, c) => write(r, c, (a) => a.cancel(...r.args)),
    'brain:defrag': (r, c) => write(r, c, (a) => a.defrag()),
    'brain:defragStop': (r, c) => write(r, c, (a) => a.defragStop()),
    'brain:undoRun': (r, c) => write(r, c, (a) => a.undoRun(...r.args)),
    'brain:tidyUndo': (r, c) => write(r, c, (a) => a.tidyUndo(...r.args)),
    'brain:setOwner': (r, c) => write(r, c, (a) => a.setOwner(...r.args)),
    'brain:merge': (r, c) => write(r, c, (a) => a.merge(...r.args)),
    'brain:describe': (r, c) => write(r, c, (a) => a.describe(...r.args)),
    'brain:removeName': (r, c) => write(r, c, (a) => a.removeName(...r.args)),
    'brain:split': (r, c) => write(r, c, (a) => a.split(...r.args)),
    'brain:forget': (r, c) => write(r, c, (a) => a.forget(...r.args)),
    'brain:queue': (r, c) =>
      run(c, async () => {
        const scopes = new LaneScope(ports.lanes, c)
        const lane = scopes.lane(r.args[0])
        return visibleJobs(
          await writer(ports, r, c, lane).queue({
            sessionPath: lane.sessionPath,
            title: lane.title,
          }),
          scopes,
        )
      }),
    'brain:neverRead': (r, c) =>
      run(c, async () => {
        const scopes = new LaneScope(ports.lanes, c)
        const lane = scopes.lane(r.args[0])
        return visibleJobs(
          await writer(ports, r, c, lane).neverRead(lane.sessionId, r.args[1]),
          scopes,
        )
      }),
    'brain:retry': (r, c) =>
      run(c, async () =>
        visibleJobs(await jobWriter(ports, r, c).retry(...r.args), new LaneScope(ports.lanes, c)),
      ),
    'brain:reread': (r, c) =>
      run(c, async () =>
        visibleJobs(await jobWriter(ports, r, c).reread(...r.args), new LaneScope(ports.lanes, c)),
      ),
  } satisfies Omit<BrainSurfaceHandlers, ReadMethod | AgentMethod>
}

function jobWriter(
  ports: BrainSurfacePorts,
  request: HostBrainRequest<'brain:retry' | 'brain:reread'>,
  caller: BrainSurfaceAuthority,
) {
  const job = ports.runtime.job(request.args[0])
  const lane = job && new LaneScope(ports.lanes, caller).source(job)
  if (!lane) refuse('not-found')
  return writer(ports, request, caller, lane)
}

type AgentMethod =
  | 'brain:tell'
  | 'brain:laneShow'
  | 'brain:laneWatch'
  | 'brain:laneSend'
  | 'brain:laneTake'
  | 'brain:laneStop'
  | 'brain:laneAnswer'
function conversation(ports: BrainSurfacePorts): Pick<BrainSurfaceHandlers, AgentMethod> {
  const { agent, runtime } = ports
  const enable = (c: BrainSurfaceAuthority) => whileEnabled(runtime.api, c)
  const page = <T>(c: BrainSurfaceAuthority, read: () => Promise<T>) =>
    run(c, async () => {
      await enable(c)
      return read()
    })
  const turn = (c: BrainSurfaceAuthority, act: () => Promise<AgentResult>) =>
    page(c, async () => {
      const result = await act()
      if (result !== 'ok') refuse(result)
      return null
    })
  return {
    'brain:laneShow': ({ args: [cursor] }, c) => page(c, () => agent.show(cursor ?? null, c)),
    'brain:laneWatch': ({ args: [cursor] }, c) => page(c, () => agent.watch(cursor ?? null, c)),
    'brain:tell': ({ args: [message] }, c) => turn(c, () => agent.tell(message, c)),
    'brain:laneSend': ({ args: [message, fence] }, c) =>
      turn(c, () => agent.send(message, fence, c)),
    'brain:laneTake': ({ args: [fence] }, c) => turn(c, () => agent.take(fence, c)),
    'brain:laneStop': ({ args: [fence, ref] }, c) => turn(c, () => agent.stop(fence, ref, c)),
    'brain:laneAnswer': ({ args: [answer, fence] }, c) =>
      turn(c, () => agent.answer(answer, fence, c)),
  }
}

export function createBrainSurfaceHandlers(ports: BrainSurfacePorts): BrainSurfaceHandlers {
  return { ...reads(ports), ...writes(ports), ...conversation(ports) }
}
