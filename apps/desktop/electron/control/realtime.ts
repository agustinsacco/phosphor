import { createHash } from 'node:crypto'
import type { TraceLog } from './observations'
import {
  MACHINES_TOPIC,
  realtimeFrameAction,
  realtimeJoinPayload,
  type RealtimeFrameState,
} from './realtime-frames'

export interface RealtimeSocket {
  send(data: string): void
  close(): void
  onopen: ((event: Event) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  onerror: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent<unknown>) => void) | null
}
export interface LiveTimers {
  after(callback: () => void, ms: number): ReturnType<typeof setTimeout>
  clear(timer: ReturnType<typeof setTimeout>): void
}
export const liveTimers: LiveTimers = {
  after: (callback, ms) => setTimeout(callback, ms),
  clear: (timer) => clearTimeout(timer),
}

interface RealtimeDeps {
  log?: TraceLog
  target: { url: string; key: string }
  socket: (url: string) => RealtimeSocket
  accessToken: () => Promise<string | null>
  generation: () => number
  timers: LiveTimers
  now: () => number
  random: () => number
  changed: () => void
  joined: (joined: boolean) => void
}

interface RealtimeState extends RealtimeFrameState {
  deps: RealtimeDeps
  url: string
  generation: number
  stopped: boolean
  socket: RealtimeSocket | null
  retry: ReturnType<typeof setTimeout> | undefined
  beat: ReturnType<typeof setTimeout> | undefined
  deadline: ReturnType<typeof setTimeout> | undefined
  backoff: number
  ref: number
  tokenHash: string
}

function clear(state: RealtimeState, timer: ReturnType<typeof setTimeout> | undefined): void {
  if (timer !== undefined) state.deps.timers.clear(timer)
}

function active(state: RealtimeState): boolean {
  return !state.stopped && state.generation === state.deps.generation()
}

function disconnect(state: RealtimeState): void {
  clear(state, state.beat)
  clear(state, state.deadline)
  const old = state.socket
  state.socket = null
  if (old) {
    old.onopen = old.onclose = old.onerror = old.onmessage = null
    old.close()
  }
  if (state.isJoined) state.deps.log?.('machines', 'realtime.left')
  state.isJoined = false
  state.joinRef = state.heartbeatRef = state.tokenHash = ''
  state.deps.joined(false)
}

// A stopped client's late auth must not report joined(false) over its replacement.
function stop(state: RealtimeState): void {
  if (state.stopped) return
  state.stopped = true
  clear(state, state.retry)
  disconnect(state)
}

function reconnect(state: RealtimeState): void {
  state.deps.log?.('machines', 'realtime.errored')
  disconnect(state)
  if (!active(state)) return stop(state)
  const delay = Math.min(60_000, state.backoff + state.backoff * 0.2 * state.deps.random())
  state.backoff = Math.min(60_000, state.backoff * 2)
  state.retry = state.deps.timers.after(() => void connect(state), delay)
}

function send(
  state: RealtimeState,
  current: RealtimeSocket,
  topic: string,
  event: string,
  payload: unknown,
): string {
  state.ref = (state.ref % Number.MAX_SAFE_INTEGER) + 1
  current.send(JSON.stringify({ topic, event, payload, ref: String(state.ref) }))
  return String(state.ref)
}

async function authenticate(state: RealtimeState, current: RealtimeSocket): Promise<string | null> {
  const token = await state.deps.accessToken()
  if (!active(state)) {
    stop(state)
    return null
  }
  if (state.socket !== current) return null
  if (!token) {
    stop(state)
    return null
  }
  return token
}

async function heartbeat(state: RealtimeState, current: RealtimeSocket): Promise<void> {
  const started = state.deps.now()
  state.deadline = state.deps.timers.after(() => reconnect(state), 10_000)
  try {
    const token = await authenticate(state, current)
    if (!token || state.socket !== current) return
    if (state.deps.now() - started >= 10_000) return reconnect(state)
    const hash = createHash('sha256').update(token).digest('hex')
    if (hash !== state.tokenHash) {
      send(state, current, MACHINES_TOPIC, 'access_token', { access_token: token })
      state.tokenHash = hash
    }
    state.heartbeatRef = send(state, current, 'phoenix', 'heartbeat', {})
    state.beat = state.deps.timers.after(() => void heartbeat(state, current), 25_000)
  } catch {
    if (state.socket === current) reconnect(state)
  }
}

async function open(state: RealtimeState, current: RealtimeSocket): Promise<void> {
  try {
    const token = await authenticate(state, current)
    if (!token) return
    state.tokenHash = createHash('sha256').update(token).digest('hex')
    state.joinRef = send(state, current, MACHINES_TOPIC, 'phx_join', realtimeJoinPayload(token))
  } catch {
    if (state.socket === current) reconnect(state)
  }
}

function receive(state: RealtimeState, current: RealtimeSocket, data: unknown): void {
  if (!active(state)) return stop(state)
  switch (realtimeFrameAction(state, data)) {
    case 'heartbeat':
      clear(state, state.deadline)
      state.heartbeatRef = ''
      break
    case 'join':
      clear(state, state.deadline)
      state.backoff = 1000
      state.deps.log?.('machines', 'realtime.joined')
      state.isJoined = true
      state.deps.joined(true)
      state.deps.changed()
      state.beat = state.deps.timers.after(() => void heartbeat(state, current), 25_000)
      break
    case 'change':
      state.deps.changed()
      break
    case 'reconnect':
      reconnect(state)
      break
  }
}

async function connect(state: RealtimeState): Promise<void> {
  if (!active(state)) return stop(state)
  try {
    const current = state.deps.socket(state.url)
    state.socket = current
    state.deadline = state.deps.timers.after(() => reconnect(state), 10_000)
    current.onclose = current.onerror = () => {
      if (state.socket === current) reconnect(state)
    }
    current.onopen = () => void open(state, current)
    current.onmessage = ({ data }) => receive(state, current, data)
  } catch {
    reconnect(state)
  }
}

export function createRealtime(deps: RealtimeDeps): { stop: () => void } {
  const url = new URL(deps.target.url)
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:'
  url.pathname = '/realtime/v1/websocket'
  url.search = new URLSearchParams({ apikey: deps.target.key, vsn: '1.0.0' }).toString()
  const state: RealtimeState = {
    deps,
    url: url.toString(),
    // Capture once: a replacement generation never reactivates this client.
    generation: deps.generation(),
    stopped: false,
    socket: null,
    retry: undefined,
    beat: undefined,
    deadline: undefined,
    backoff: 1000,
    ref: 0,
    joinRef: '',
    heartbeatRef: '',
    tokenHash: '',
    isJoined: false,
  }
  void connect(state)
  return { stop: () => stop(state) }
}
