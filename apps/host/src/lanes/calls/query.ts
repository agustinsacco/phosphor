import { hostLaneReceipt } from '../receipt'
import { isUuid } from '@phosphor/shared/control-api'
import { HOST_LIMITS, utf8Length } from '@phosphor/shared/host-protocol'
import { subagentEvidence } from '@phosphor/shared/subagent-evidence'
import {
  parseSubagentInspectRequest,
  subagentInspectPrompt,
  SUBAGENT_INSPECT_COMMAND,
} from '@phosphor/shared/subagent-inspect'
import type { RpcCommand, RpcResponse } from '@phosphor/shared/rpc'
import type { RuntimeLog } from '@phosphor/session-runtime/file-log'
import type { HostRuntime } from '../../session/runtime'
import type { createLiveLanes } from '../live'
import { advertisesExtensionCommand, piMessages, piState } from '../pi-results'
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
  ['lane.subagentHistory', { type: 'get_entries' }],
])
/** Not a pi query: the Host exports to its own file and returns the document. */
const EXPORT = 'lane.exportHtml'
/** A read by extension command. As a call it needs no fence, so it never takes control. */
const INSPECT = 'lane.subagentInspect'
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
  if (method === 'lane.subagentHistory')
    return Array.isArray(data.entries) && (data.leafId === null || typeof data.leafId === 'string')
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
    Partial<Pick<ReturnType<typeof createLiveLanes>, 'receiptTiming' | 'repositories'>>
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
  return method === 'host.repositories' || method === INSPECT || queries.has(method)
    ? 'sessions.read'
    : null
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

/**
 * The command deadline for a live read: the client stops waiting then, so the
 * call's slot is freed too. Null when it passed; the work itself runs on.
 */
async function withinDeadline<T>(work: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), HOST_LIMITS.commandAnswerMs)
        timer.unref()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function requestLiveQuery(
  options: Pick<LaneQueryOptions, 'runtime'>,
  method: string,
  sessionId: string,
  command: RpcCommand,
  receipt: ReceiptResult,
): Promise<CallOutcome> {
  try {
    const response = await withinDeadline(options.runtime.command(sessionId, command))
    if (!response?.success || !shape(method, response.data)) return failure('internal')
    if (method === 'lane.receipt' && record(response.data)) {
      const messages = piMessages(response.data.messages)
      if (!messages) return failure('internal')
      return receipt(messages)
    }
    if (method === 'lane.subagentHistory' && record(response.data))
      return subagentHistory(
        response.data.entries as unknown[],
        response.data.leafId as string | null,
      )
    return { ok: true, data: response.data }
  } catch {
    return failure('internal')
  }
}

/** Leaves room in the result frame for its envelope and JSON escaping of the document. */
const RESULT_MAX_BYTES = HOST_LIMITS.outboundFrameBytes / 2

/** The session's subagent records on its active branch, never the whole file. */
function subagentHistory(entries: unknown[], leafId: string | null): CallOutcome {
  const evidence = subagentEvidence(entries, leafId)
  return utf8Length(JSON.stringify(evidence)) > RESULT_MAX_BYTES
    ? failure('too-large')
    : { ok: true, data: evidence }
}

/** The pi session of the running lane a call names, or its refusal. */
function liveSession(
  options: Pick<LaneQueryOptions, 'store' | 'live'>,
  params: unknown,
): string | CallOutcome {
  if (!record(params)) return failure('bad-request')
  const laneId = params.laneId
  if (typeof laneId !== 'string' || !isUuid(laneId)) return failure('bad-request')
  const lane = options.store.getLane(laneId)
  if (!lane || lane.removedAt !== null) return failure('unknown-lane')
  return options.live.sessionFor(laneId) ?? failure('lane-stopped')
}

/**
 * pi-subagents answers on the lane's `subagent-inspect` widget, which every viewer's
 * stream carries, as This Mac's window receives it. Only the Host-built command reaches
 * pi, and only while pi lists it: otherwise pi would send the text to the model.
 */
async function subagentInspect(
  options: Pick<LaneQueryOptions, 'runtime' | 'store' | 'live'>,
  params: unknown,
): Promise<CallOutcome> {
  const request = parseSubagentInspectRequest(params)
  if (!request) return failure('bad-request')
  const sessionId = liveSession(options, params)
  if (typeof sessionId !== 'string') return sessionId
  try {
    const listed = await withinDeadline(
      options.runtime.command(sessionId, { type: 'get_commands' }),
    )
    if (!listed?.success) return failure('internal')
    if (!advertisesExtensionCommand(listed.data, SUBAGENT_INSPECT_COMMAND))
      return failure('unsupported')
    const message = subagentInspectPrompt(request)
    const sent = await withinDeadline(
      options.runtime.command(sessionId, { type: 'prompt', message }),
    )
    return sent?.success ? { ok: true, data: null } : failure('internal')
  } catch {
    return failure('internal')
  }
}

async function exportHtml(
  options: Pick<LaneQueryOptions, 'runtime' | 'store' | 'live'>,
  params: unknown,
): Promise<CallOutcome> {
  const sessionId = liveSession(options, params)
  if (typeof sessionId !== 'string') return sessionId
  if (!options.runtime.exportHtml) return failure('unsupported')
  // A late answer still removes its folder.
  try {
    const html = await withinDeadline(options.runtime.exportHtml(sessionId, RESULT_MAX_BYTES))
    return html === null ? failure('internal') : { ok: true, data: { html } }
  } catch (error) {
    return failure(error instanceof ExportTooLarge ? 'too-large' : 'internal')
  }
}

export async function resolveLaneQuery(
  options: LaneQueryOptions,
  method: string,
  params: unknown,
): Promise<CallOutcome> {
  if (method === EXPORT) return exportHtml(options, params)
  if (method === INSPECT) return subagentInspect(options, params)
  const command = queries.get(method)
  if (method !== 'host.repositories' && !command) return failure('unsupported')
  if (!record(params)) return failure('bad-request')
  if (method === 'host.repositories')
    return { ok: true, data: options.live.repositories?.() ?? options.store.listRepositories() }
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
