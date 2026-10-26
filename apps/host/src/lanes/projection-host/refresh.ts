import type { RpcResponse } from '@phosphor/shared/rpc'
import type { LaneProjection } from '@phosphor/session-runtime/lanes/projection'
import type { HostRuntime } from '../../session/runtime'
import { PI_MESSAGES_MAX, piMessages, piState } from '../pi-results'

export type ProjectionRefreshOptions = {
  runtime: { command: (...args: Parameters<HostRuntime['command']>) => Promise<RpcResponse> }
  sessionId: string
  laneId: string
  projection: LaneProjection
  log: (message: string, data: { laneId: string; reason: 'rpc' | 'shape' | 'size' }) => void
}

type RefreshState = {
  revision: number
  requested: boolean
  settle: boolean
  stopped: boolean
  refreshing: Promise<void> | undefined
}

function data(response: RpcResponse): unknown {
  if (!response.success || response.data === undefined) throw new Error('refresh failed')
  return response.data
}

async function runRefresh(state: RefreshState, options: ProjectionRefreshOptions) {
  const { projection } = options
  while (state.requested && !state.stopped) {
    state.requested = false
    const full = state.settle
    state.settle = false
    const before = state.revision
    if (full) projection.markSettle()
    let reason: 'rpc' | 'shape' | 'size' = 'rpc'
    try {
      const result = full
        ? data(await options.runtime.command(options.sessionId, { type: 'get_messages' }))
        : undefined
      if (state.stopped) return
      if (full) projection.markRead()
      const stateResult = data(
        await options.runtime.command(options.sessionId, { type: 'get_state' }),
      )
      if (state.stopped) return
      // Newer requests supersede this pair. Full reads reconcile delivered messages;
      // state-only reads require an unchanged event revision.
      if (state.requested || (!full && before !== state.revision)) {
        state.requested = true
        state.settle ||= full
        continue
      }
      const payload =
        typeof result === 'object' && result !== null && 'messages' in result
          ? result.messages
          : undefined
      reason = Array.isArray(payload) && payload.length > PI_MESSAGES_MAX ? 'size' : 'shape'
      const messages = full ? piMessages(payload) : []
      const nextState = piState(stateResult)
      if (!messages || !nextState) throw new Error('refresh failed')
      if (full) projection.settle(messages, nextState)
      else projection.setState(nextState)
    } catch {
      if (!state.stopped) options.log('lanes.refresh_failed', { laneId: options.laneId, reason })
    }
  }
}

function refresh(
  state: RefreshState,
  options: ProjectionRefreshOptions,
  full: boolean,
): Promise<void> {
  if (state.stopped) return Promise.resolve()
  state.requested = true
  state.settle ||= full
  state.refreshing ??= refreshThenFollow(state, options)
  return state.refreshing
}

/** One run, then one more if a request arrived meanwhile; settles after both. */
async function refreshThenFollow(state: RefreshState, options: ProjectionRefreshOptions) {
  try {
    await runRefresh(state, options)
  } finally {
    state.refreshing = undefined
    if (state.requested && !state.stopped) await refresh(state, options, false)
  }
}

export function createProjectionRefresh(options: ProjectionRefreshOptions) {
  const state: RefreshState = {
    revision: 0,
    requested: false,
    settle: false,
    stopped: false,
    refreshing: undefined,
  }
  return {
    refresh: (full = true) => refresh(state, options, full),
    advanceRevision() {
      state.revision++
    },
    isStopped: () => state.stopped,
    stop() {
      state.stopped = true
      state.requested = state.settle = false
    },
  }
}
