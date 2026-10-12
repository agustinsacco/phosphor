import { createHash } from 'node:crypto'

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
const TOPIC = 'realtime:machines'
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export function createRealtime(deps: {
  target: { url: string; key: string }
  socket: (url: string) => RealtimeSocket
  accessToken: () => Promise<string | null>
  generation: () => number
  timers: LiveTimers
  now: () => number
  random: () => number
  changed: () => void
  joined: (joined: boolean) => void
}): { stop: () => void } {
  const url = new URL(deps.target.url)
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:'
  url.pathname = '/realtime/v1/websocket'
  url.search = new URLSearchParams({ apikey: deps.target.key, vsn: '1.0.0' }).toString()
  const generation = deps.generation()
  let stopped = false
  let socket: RealtimeSocket | null = null
  let retry: ReturnType<typeof setTimeout> | undefined
  let beat: ReturnType<typeof setTimeout> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let backoff = 1000
  let ref = 0
  let joinRef = ''
  let heartbeatRef = ''
  let tokenHash = ''
  let isJoined = false
  const clear = (timer: ReturnType<typeof setTimeout> | undefined): void => {
    if (timer !== undefined) deps.timers.clear(timer)
  }
  const active = (): boolean => !stopped && generation === deps.generation()
  function disconnect(): void {
    clear(beat)
    clear(deadline)
    const old = socket
    socket = null
    if (old) {
      old.onopen = old.onclose = old.onerror = old.onmessage = null
      old.close()
    }
    isJoined = false
    joinRef = heartbeatRef = tokenHash = ''
    deps.joined(false)
  }
  function stop(): void {
    stopped = true
    clear(retry)
    disconnect()
  }
  function reconnect(): void {
    disconnect()
    if (!active()) return stop()
    const delay = Math.min(60_000, backoff + backoff * 0.2 * deps.random())
    backoff = Math.min(60_000, backoff * 2)
    retry = deps.timers.after(() => void connect(), delay)
  }
  function send(current: RealtimeSocket, topic: string, event: string, payload: unknown): string {
    ref = (ref % Number.MAX_SAFE_INTEGER) + 1
    current.send(JSON.stringify({ topic, event, payload, ref: String(ref) }))
    return String(ref)
  }
  async function authenticate(current: RealtimeSocket): Promise<string | null> {
    const token = await deps.accessToken()
    if (!active()) {
      stop()
      return null
    }
    if (socket !== current) return null
    if (!token) {
      stop()
      return null
    }
    return token
  }
  async function heartbeat(current: RealtimeSocket): Promise<void> {
    const started = deps.now()
    deadline = deps.timers.after(reconnect, 10_000)
    try {
      const token = await authenticate(current)
      if (!token || socket !== current) return
      if (deps.now() - started >= 10_000) return reconnect()
      const hash = createHash('sha256').update(token).digest('hex')
      if (hash !== tokenHash) {
        send(current, TOPIC, 'access_token', { access_token: token })
        tokenHash = hash
      }
      heartbeatRef = send(current, 'phoenix', 'heartbeat', {})
      beat = deps.timers.after(() => void heartbeat(current), 25_000)
    } catch {
      if (socket === current) reconnect()
    }
  }
  async function connect(): Promise<void> {
    if (!active()) return stop()
    try {
      const current = deps.socket(url.toString())
      socket = current
      deadline = deps.timers.after(reconnect, 10_000)
      current.onclose = current.onerror = () => {
        if (socket === current) reconnect()
      }
      current.onopen = () => {
        void (async () => {
          try {
            const token = await authenticate(current)
            if (!token) return
            tokenHash = createHash('sha256').update(token).digest('hex')
            joinRef = send(current, TOPIC, 'phx_join', {
              config: {
                postgres_changes: [{ event: '*', schema: 'public', table: 'remote_hosts' }],
              },
              access_token: token,
            })
          } catch {
            if (socket === current) reconnect()
          }
        })()
      }
      current.onmessage = ({ data }) => {
        if (!active()) return stop()
        if (typeof data !== 'string' || Buffer.byteLength(data) > 64 * 1024) return
        let frame: unknown
        try {
          frame = JSON.parse(data)
        } catch {
          return
        }
        if (!record(frame) || !record(frame.payload)) return
        if (
          isJoined &&
          heartbeatRef !== '' &&
          frame.topic === 'phoenix' &&
          frame.event === 'phx_reply' &&
          frame.ref === heartbeatRef &&
          frame.payload.status === 'ok'
        ) {
          clear(deadline)
          heartbeatRef = ''
        } else if (frame.topic === TOPIC) {
          if (joinRef !== '' && frame.event === 'phx_reply' && frame.ref === joinRef) {
            if (frame.payload.status !== 'ok') return reconnect()
            if (isJoined) return
            clear(deadline)
            backoff = 1000
            isJoined = true
            deps.joined(true)
            deps.changed()
            beat = deps.timers.after(() => void heartbeat(current), 25_000)
          } else if (frame.event === 'postgres_changes' && isJoined) deps.changed()
          else if (frame.event === 'phx_error' || frame.event === 'phx_close') reconnect()
        }
      }
    } catch {
      reconnect()
    }
  }
  void connect()
  return { stop }
}
