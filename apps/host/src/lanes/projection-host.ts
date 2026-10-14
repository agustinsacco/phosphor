import {
  HOST_LIMITS,
  type LaneSnapshot,
  type LaneSummary,
  type StreamCursor,
} from '@phosphor/shared/host-protocol'
import type { SessionPush } from '@phosphor/shared/models'
import type { RpcResponse } from '@phosphor/shared/rpc'
import type { LaneProjection } from '@phosphor/session-runtime/lanes/projection'
import type { HostRuntime } from '../session/runtime'
import { PI_MESSAGES_MAX, piMessages, piState } from './pi-results'

const SNAPSHOT_BYTES = HOST_LIMITS.outboundFrameBytes - 64 * 1024
export type SnapshotResult =
  { ok: true; snapshot: LaneSnapshot } | { ok: false; reason: 'too-large' }

export function createHostLaneProjection(options: {
  runtime: { command: (...args: Parameters<HostRuntime['command']>) => Promise<RpcResponse> }
  sessionId: string
  laneId: string
  projection: LaneProjection
  summary: () => LaneSummary
  cursor: () => StreamCursor
  log: (message: string, data: { laneId: string; reason: 'rpc' | 'shape' | 'size' }) => void
}) {
  const { projection } = options
  let revision = 0
  let requested = false
  let settle = false
  let stopped = false
  let refreshing: Promise<void> | undefined
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const view = (): LaneSnapshot => ({
    ...projection.view(),
    summary: options.summary(),
    cursor: options.cursor(),
  })
  function data(response: RpcResponse): unknown {
    if (!response.success || response.data === undefined) throw new Error('refresh failed')
    return response.data
  }
  async function runRefresh() {
    while (requested && !stopped) {
      requested = false
      const full = settle
      settle = false
      const before = revision
      if (full) projection.markSettle()
      let reason: 'rpc' | 'shape' | 'size' = 'rpc'
      try {
        const result = full
          ? data(await options.runtime.command(options.sessionId, { type: 'get_messages' }))
          : undefined
        if (stopped) return
        if (full) projection.markRead()
        const stateResult = data(
          await options.runtime.command(options.sessionId, { type: 'get_state' }),
        )
        if (stopped) return
        // Newer requests supersede this pair. Full reads reconcile delivered messages;
        // state-only reads require an unchanged event revision.
        if (requested || (!full && before !== revision)) {
          requested = true
          settle ||= full
          continue
        }
        const payload =
          typeof result === 'object' && result !== null && 'messages' in result
            ? result.messages
            : undefined
        reason = Array.isArray(payload) && payload.length > PI_MESSAGES_MAX ? 'size' : 'shape'
        const messages = full ? piMessages(payload) : []
        const state = piState(stateResult)
        if (!messages || !state) throw new Error('refresh failed')
        if (full) projection.settle(messages, state)
        else projection.setState(state)
      } catch {
        if (!stopped) options.log('lanes.refresh_failed', { laneId: options.laneId, reason })
      }
    }
  }
  function refresh(full = true): Promise<void> {
    if (stopped) return Promise.resolve()
    requested = true
    settle ||= full
    if (!refreshing)
      refreshing = runRefresh().finally(() => {
        refreshing = undefined
        if (requested && !stopped) return refresh(false)
      })
    return refreshing
  }
  function clearTimer(id: string) {
    clearTimeout(timers.get(id))
    timers.delete(id)
  }
  function dispose() {
    stopped = true
    requested = settle = false
    for (const id of timers.keys()) clearTimer(id)
  }
  return {
    refresh,
    dispose,
    stateChanged: () => refresh(false),
    deliver(push: SessionPush) {
      // resync is Desktop-local; a Host runtime never produces it.
      if (push.kind === 'stderr' || push.kind === 'resync' || stopped) return
      revision++
      projection.apply(push)
      if (push.kind === 'exit') {
        dispose()
      } else if (push.kind === 'event') {
        if (push.event.type === 'compaction_end') void refresh()
        else if (push.event.type === 'agent_end') void refresh(false)
      } else {
        const request = push.request
        if (['select', 'confirm', 'input', 'editor'].includes(request.method))
          clearTimer(request.id)
        if ('timeout' in request && request.timeout !== undefined) {
          if (projection.view().dialogs.some((d) => d.id === request.id)) {
            const expires = Date.now() + request.timeout
            const arm = () => {
              const remaining = expires - Date.now()
              const timer = setTimeout(
                () => {
                  if (Date.now() < expires) arm()
                  else {
                    projection.resolveDialog(request.id)
                    timers.delete(request.id)
                  }
                },
                Math.min(remaining, 2 ** 31 - 1),
              )
              timer.unref()
              timers.set(request.id, timer)
            }
            arm()
          }
        }
      }
    },
    resolveDialog(id: string) {
      clearTimer(id)
      projection.resolveDialog(id)
    },
    snapshot(): SnapshotResult {
      return fitSnapshot(view())
    },
  }
}

export function fitSnapshot(input: LaneSnapshot): SnapshotResult {
  let snapshot = input
  let bytes = Buffer.byteLength(JSON.stringify(snapshot))
  if (bytes <= SNAPSHOT_BYTES) return { ok: true, snapshot }
  // Elide only in the delivered copy, oldest first. pi's transcript is unchanged.
  const messages = structuredClone(snapshot.messages)
  snapshot = { ...snapshot, messages }
  for (const message of messages) {
    if (!('content' in message) || !Array.isArray(message.content)) continue
    for (const [index, block] of message.content.entries()) {
      if (block.type !== 'image') continue
      const omitted = {
        type: 'text' as const,
        text: `[image omitted: ${Math.ceil(Buffer.byteLength(block.data) / 1024)} KB]`,
      }
      bytes += Buffer.byteLength(JSON.stringify(omitted)) - Buffer.byteLength(JSON.stringify(block))
      message.content[index] = omitted
      if (bytes <= SNAPSHOT_BYTES) return { ok: true, snapshot }
    }
  }
  return { ok: false, reason: 'too-large' }
}
