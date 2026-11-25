import { missingHistoryResponse } from '@phosphor/shared/errors'
import { HOST_LIMITS, utf8Length } from '@phosphor/shared/host-protocol'
import type { RpcCommand, RpcResponse } from '@phosphor/shared/rpc'
import type { browserCrypto } from './crypto'
import { laneOperation, receiptResponse, REMOTE_UNAVAILABLE, sendToLane } from './lane-ops'
import { flush, isStopped, type Handle, type Connection } from './lane-stream'
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type CommandPorts = {
  identity: Pick<typeof browserCrypto, 'randomUUID' | 'randomHex'>
  connection(hostId: string, control?: boolean): Connection
  label(hostId: string): string
  current(): boolean
}
async function projectedState(
  h: Handle,
  c: Connection,
  id: string,
  base: Pick<RpcResponse, 'type' | 'command' | 'id'>,
): Promise<RpcResponse> {
  if (!h.hydration) {
    try {
      const result = await c.call('lane.state', { laneId: h.laneId })
      if (result.ok && record(result.data)) {
        const { sessionFile: _file, ...state } = result.data
        h.lastState = state
        h.stateRun = h.run
        return { ...base, success: true, data: { ...state, sessionId: id } }
      }
    } catch {
      // A stopped or unavailable Host keeps the last projected state usable.
    }
  }
  // A running lane serves only what its current pi run reported; a stopped
  // one keeps the last state it had.
  const summary = h.hydration?.summary ?? h.summary
  const ours = (run: number | undefined) =>
    isStopped(h.summary.activity) || (run ?? 0) === (h.run ?? 0)
  const last = ours(h.stateRun) ? h.lastState : undefined
  const projected = ours(h.projectionRun)
    ? (h.hydration?.view ?? h.projection.view()).state
    : undefined
  const state = h.hydration ? (projected ?? last) : (last ?? projected)
  if (!state)
    return {
      ...base,
      success: false,
      error: isStopped(summary.activity) ? 'Lane is stopped.' : 'Lane is starting.',
    }
  const { sessionFile: _file, ...safe } = state
  return {
    ...base,
    success: true,
    data: {
      ...safe,
      sessionId: id,
      sessionName: summary.title ?? undefined,
      // Never relabel stale model metadata with a different model's ids.
      model:
        record(safe.model) &&
        (!summary.model ||
          (safe.model.provider === summary.model.provider && safe.model.id === summary.model.id))
          ? safe.model
          : undefined,
      isStreaming: summary.activity === 'working',
      messageCount: (h.hydration?.view ?? h.projection.view()).messages.length,
    },
  }
}
export async function laneCommand(
  h: Handle,
  command: RpcCommand,
  ports: CommandPorts,
): Promise<RpcResponse> {
  const { identity, connection } = ports
  const id = h.info.sessionId
  const base = { type: 'response' as const, command: command.type, id: command.id }
  const op = laneOperation(command)
  if (!op) return { ...base, success: false, error: REMOTE_UNAVAILABLE }
  try {
    const c = connection(h.hostId, typeof op !== 'string')
    if (command.type === 'get_state') return await projectedState(h, c, id, base)
    if (command.type === 'get_messages') {
      // IPC replies hydrate first, then replay the unfinished turn and UI.
      const hydration = h.hydration
      if (hydration) {
        clearTimeout(hydration.timer)
        hydration.timer = setTimeout(() => {
          if (ports.current() && h.hydration === hydration) flush(h)
        }, 0)
      }
      if (h.previewUnavailable) return { ...base, ...missingHistoryResponse }
      return {
        ...base,
        success: true,
        data: { messages: (h.hydration?.view ?? h.projection.view()).messages },
      }
    }
    if (typeof op === 'string') {
      const result = await c.call(op, { laneId: h.laneId })
      let data: unknown = result.ok ? result.data : undefined
      if (op === 'lane.stats' && record(data)) {
        const { sessionFile: _file, ...stats } = data
        data = { ...stats, sessionId: id }
      }
      return result.ok
        ? { ...base, success: true, data }
        : { ...base, success: false, error: result.error.message }
    }
    if (
      (op.type === 'prompt' || op.type === 'steer' || op.type === 'follow_up') &&
      op.images?.length &&
      utf8Length(
        JSON.stringify({
          type: 'command',
          requestId: identity.randomUUID(),
          laneId: h.laneId,
          fence: h.summary.control.fence,
          trace: identity.randomHex(8),
          op,
        }),
      ) >
        HOST_LIMITS.inboundFrameBytes - 1024
    )
      return { ...base, success: false, error: 'Image too large for a remote lane.' }
    const result = await sendToLane(c, op, h.laneId, h.summary.control.fence)
    return { ...receiptResponse(command.type, result, ports.label(h.hostId)), id: command.id }
  } catch {
    return { ...base, success: false, error: REMOTE_UNAVAILABLE }
  }
}
