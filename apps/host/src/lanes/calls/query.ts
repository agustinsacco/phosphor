import { hostLaneReceipt } from '../receipt'
import { isUuid } from '@phosphor/shared/control-api'
import { HOST_LIMITS } from '@phosphor/shared/host-protocol'
import type { RpcCommand, RpcResponse } from '@phosphor/shared/rpc'
import type { RuntimeLog } from '@phosphor/session-runtime/file-log'
import type { HostRuntime } from '../../session/runtime'
import type { createLiveLanes } from '../live'
import { piMessages, piState } from '../pi-results'
import { ExportTooLarge } from '../../session/html-export'
import type { SnapshotResult } from '../projection-host'
import type { CallOutcome } from '../service'
import type { HostStore } from '../store'
import type { HostCapability } from '@phosphor/shared/remote-host'

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const queries = new Map<string, RpcCommand>([
  ['lane.state', { type: 'get_state' }],
  ['lane.messages', { type: 'get_messages' }],
  ['lane.receipt', { type: 'get_messages' }],
  ['lane.stats', { type: 'get_session_stats' }],
  ['lane.models', { type: 'get_available_models' }],
  ['lane.commands', { type: 'get_commands' }],
])
/** Not a pi query: the Host exports to its own file and returns the document. */
const EXPORT = 'lane.exportHtml'
const failure = (code: Extract<CallOutcome, { ok: false }>['error']['code']): CallOutcome => ({
  ok: false,
  error: { code, message: 'the lane query could not complete' },
})
function shape(method: string, data: unknown): boolean {
  if (method === 'lane.state') return piState(data) !== null
  if (!record(data)) return false
  if (method === 'lane.messages' || method === 'lane.receipt')
    return piMessages(data.messages) !== null
  if (method === 'lane.models') return Array.isArray(data.models)
  if (method === 'lane.commands') return Array.isArray(data.commands)
  const tokens = data.tokens
  return (
    [
      'userMessages',
      'assistantMessages',
      'toolCalls',
      'toolResults',
      'totalMessages',
      'cost',
    ].every((key) => typeof data[key] === 'number' && Number.isFinite(data[key])) &&
    record(tokens) &&
    ['input', 'output', 'cacheRead', 'cacheWrite', 'total'].every(
      (key) => typeof tokens[key] === 'number' && Number.isFinite(tokens[key]),
    )
  )
}

export interface LaneQueryOptions {
  store: Pick<HostStore, 'listRepositories' | 'getLane'>
  live: Pick<ReturnType<typeof createLiveLanes>, 'sessionFor'> &
    Partial<Pick<ReturnType<typeof createLiveLanes>, 'receiptTiming'>>
  runtime: {
    command(...args: Parameters<HostRuntime['command']>): Promise<RpcResponse>
    exportHtml?: HostRuntime['exportHtml']
  }
  unattached(laneId: string): SnapshotResult | null
  now(): number
  log: RuntimeLog
}
type ReceiptResult = (messages: Parameters<typeof hostLaneReceipt>[0]) => CallOutcome

export function laneQueryCapability(method: string): HostCapability | null {
  // An export carries more than lane.messages: pi's system prompt (context files,
  // skills catalogue), tool definitions and the whole session tree. So it needs
  // the grant's control capability, though not control of the lane.
  if (method === EXPORT) return 'sessions.control'
  return method === 'host.repositories' || queries.has(method) ? 'sessions.read' : null
}

export function stoppedQuery(
  options: Pick<LaneQueryOptions, 'unattached'>,
  method: string,
  laneId: string,
  receipt: ReceiptResult,
): CallOutcome {
  try {
    if (method === 'lane.state') return { ok: true, data: null }
    if (method !== 'lane.messages' && method !== 'lane.receipt') return failure('lane-stopped')
    const snapshot = options.unattached(laneId)
    if (snapshot === null) return failure('internal')
    if (snapshot.ok && method === 'lane.receipt') return receipt(snapshot.snapshot.messages)
    return snapshot.ok
      ? { ok: true, data: { messages: snapshot.snapshot.messages } }
      : failure('too-large')
  } catch {
    return failure('internal')
  }
}

export async function requestLiveQuery(
  options: Pick<LaneQueryOptions, 'runtime'>,
  method: string,
  sessionId: string,
  command: RpcCommand,
  receipt: ReceiptResult,
): Promise<CallOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const response = await Promise.race([
      options.runtime.command(sessionId, command),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), HOST_LIMITS.commandAnswerMs)
        timer.unref()
      }),
    ])
    if (!response?.success || !shape(method, response.data)) return failure('internal')
    if (method === 'lane.receipt' && record(response.data)) {
      const messages = piMessages(response.data.messages)
      if (!messages) return failure('internal')
      return receipt(messages)
    }
    return { ok: true, data: response.data }
  } catch {
    return failure('internal')
  } finally {
    clearTimeout(timer)
  }
}

/** Leaves room in the result frame for its envelope and JSON escaping of the document. */
const EXPORT_MAX_BYTES = HOST_LIMITS.outboundFrameBytes / 2

async function exportHtml(
  options: Pick<LaneQueryOptions, 'runtime' | 'store' | 'live'>,
  params: unknown,
): Promise<CallOutcome> {
  if (!record(params)) return failure('bad-request')
  const laneId = params.laneId
  if (typeof laneId !== 'string' || !isUuid(laneId)) return failure('bad-request')
  const lane = options.store.getLane(laneId)
  if (!lane || lane.removedAt !== null) return failure('unknown-lane')
  const sessionId = options.live.sessionFor(laneId)
  if (sessionId === null) return failure('lane-stopped')
  if (!options.runtime.exportHtml) return failure('unsupported')
  // Same deadline as a live read: the client stops waiting then, so the call's
  // slot is freed too. A late answer still removes its folder.
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const html = await Promise.race([
      options.runtime.exportHtml(sessionId, EXPORT_MAX_BYTES),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), HOST_LIMITS.commandAnswerMs)
        timer.unref()
      }),
    ])
    return html === null ? failure('internal') : { ok: true, data: { html } }
  } catch (error) {
    return failure(error instanceof ExportTooLarge ? 'too-large' : 'internal')
  } finally {
    clearTimeout(timer)
  }
}

export async function resolveLaneQuery(
  options: LaneQueryOptions,
  method: string,
  params: unknown,
): Promise<CallOutcome> {
  if (method === EXPORT) return exportHtml(options, params)
  const command = queries.get(method)
  if (method !== 'host.repositories' && !command) return failure('unsupported')
  if (!record(params)) return failure('bad-request')
  if (method === 'host.repositories') return { ok: true, data: options.store.listRepositories() }
  if (!command) return failure('unsupported')
  const laneId = params.laneId
  if (typeof laneId !== 'string' || !isUuid(laneId)) return failure('bad-request')
  const lane = options.store.getLane(laneId)
  if (!lane || lane.removedAt !== null) return failure('unknown-lane')
  const receipt: ReceiptResult = (messages) => ({
    ok: true,
    data: hostLaneReceipt(
      messages,
      {
        title: lane.title ?? 'Untitled lane',
        branch: lane.branch,
        repository:
          options.store.listRepositories().find((repo) => repo.id === lane.repositoryId)?.name ??
          null,
      },
      options.live.receiptTiming?.(laneId),
      lane.cwd,
    ),
  })
  const sessionId = options.live.sessionFor(laneId)
  return sessionId === null
    ? stoppedQuery(options, method, laneId, receipt)
    : requestLiveQuery(options, method, sessionId, command, receipt)
}
