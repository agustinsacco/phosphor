export const MACHINES_TOPIC = 'realtime:machines'

export interface RealtimeFrameState {
  isJoined: boolean
  joinRef: string
  heartbeatRef: string
}

export type RealtimeFrameAction = 'ignore' | 'heartbeat' | 'join' | 'change' | 'reconnect'

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export function realtimeJoinPayload(token: string): {
  config: { postgres_changes: { event: string; schema: string; table: string }[] }
  access_token: string
} {
  return {
    config: { postgres_changes: [{ event: '*', schema: 'public', table: 'remote_hosts' }] },
    access_token: token,
  }
}

export function realtimeFrameAction(state: RealtimeFrameState, data: unknown): RealtimeFrameAction {
  if (typeof data !== 'string' || Buffer.byteLength(data) > 64 * 1024) return 'ignore'
  let frame: unknown
  try {
    frame = JSON.parse(data)
  } catch {
    return 'ignore'
  }
  if (!record(frame) || !record(frame.payload)) return 'ignore'
  if (
    state.isJoined &&
    state.heartbeatRef !== '' &&
    frame.topic === 'phoenix' &&
    frame.event === 'phx_reply' &&
    frame.ref === state.heartbeatRef &&
    frame.payload.status === 'ok'
  )
    return 'heartbeat'
  if (frame.topic !== MACHINES_TOPIC) return 'ignore'
  if (state.joinRef !== '' && frame.event === 'phx_reply' && frame.ref === state.joinRef) {
    if (frame.payload.status !== 'ok') return 'reconnect'
    return state.isJoined ? 'ignore' : 'join'
  }
  if (frame.event === 'postgres_changes' && state.isJoined) return 'change'
  if (frame.event === 'phx_error' || frame.event === 'phx_close') return 'reconnect'
  return 'ignore'
}
