import { randomBytes } from 'node:crypto'
import type { BrainAccess } from '@phosphor/shared/brain-access'
import type { GrantClient } from '@phosphor/shared/host-grant'
import {
  HOST_LIMITS,
  parseClientFrame,
  utf8Length,
  type FrameSocket,
  type HostFrame,
  type HostCloseCode,
  type ClientFrame,
} from '@phosphor/shared/host-protocol'
import type { HostCapability } from '@phosphor/shared/remote-host'
import type { Authentication, ConnectionAuthenticator } from './grant-auth'
import { connectionLimits, type ConnectionLimits } from './connection-limits'
import type { ConnectionPrincipal } from './principal'

export { hostProof } from './ready-frame'

export type ApiLog = (event: string, fields: Record<string, string | number>) => void
export interface ReadyConnection {
  connectionId: string
  trace?: string
  client: GrantClient
  /** Absent means a user grant: every connection before principals existed. */
  principal?: ConnectionPrincipal
  caps: readonly HostCapability[]
  brainAccess?: readonly BrainAccess[]
  credentialLive?(): boolean
  socket: FrameSocket
}
export type AuthenticatedFrame = Exclude<ClientFrame, { type: 'auth' | 'ping' }>
export interface AuthenticatedHandler {
  handle(frame: AuthenticatedFrame, caps: readonly HostCapability[]): void
  renew(caps: readonly HostCapability[], brainAccess?: readonly BrainAccess[]): void
  close(): void
}
export interface ConnectionPorts {
  socket: FrameSocket
  /** Verifies auth frames and watches what admitted the connection. */
  authenticate: ConnectionAuthenticator
  admit(clientId: string): boolean
  ping?: () => void
  handler?(connection: ReadyConnection): AuthenticatedHandler | undefined
  onReady?(connection: ReadyConnection): void
  onClose?(connectionId: string): void
  log?: ApiLog
  now?: () => number
  limits?: ConnectionLimits
}

/** Who an accepted credential speaks for, as the ready connection carries it. */
function identity({ client, principal }: Authentication) {
  return { client, principal }
}

function unanswered(frame: AuthenticatedFrame, send: (frame: HostFrame) => void) {
  if (frame.type === 'subscribe')
    send({ type: 'subscribe-failed', id: frame.id, code: 'forbidden' })
  else if (frame.type === 'command')
    send({
      type: 'receipt',
      receipt: { requestId: frame.requestId, status: 'rejected', code: 'forbidden' },
    })
  else if (frame.type === 'receipt-status')
    send({ type: 'receipt', receipt: { requestId: frame.requestId, status: 'unknown' } })
  else if (frame.type === 'call')
    send({
      type: 'result',
      id: frame.id,
      ok: false,
      error: { code: 'unsupported', message: 'unsupported' },
    })
}

export function createConnection(ports: ConnectionPorts) {
  const { socket } = ports
  const now = ports.now ?? Date.now
  const limits = connectionLimits(ports.limits)
  const connectionId = randomBytes(8).toString('hex')
  const started = now()
  let trace: string | undefined
  /** The authenticated client; set once the first credential is accepted. */
  let client: GrantClient | undefined
  let handler: AuthenticatedHandler | undefined
  let caps: readonly HostCapability[] = []
  let closeAt = 0
  let ended = false
  let checking = false
  let expiry: ReturnType<typeof setTimeout> | undefined
  const deadline = setTimeout(() => close(4401), limits.authTimeoutMs)
  let idle = setTimeout(() => close(4401), limits.idleCloseMs)
  const heartbeat = setInterval(() => ports.ping?.(), limits.pingIntervalMs)
  heartbeat.unref()
  const unsubscribe = ports.authenticate.watch(() => close(4403))
  function finish(code: number) {
    if (ended) return
    ended = true
    clearTimeout(deadline)
    clearTimeout(expiry)
    clearInterval(heartbeat)
    clearTimeout(idle)
    unsubscribe()
    if (code === 4401 || code === 4403) handler?.renew([])
    handler?.close()
    ports.onClose?.(connectionId)
    ports.log?.('api.closed', {
      ...(trace ? { trace } : {}),
      code,
      ms: Math.max(0, now() - started),
    })
  }
  function close(code: HostCloseCode) {
    finish(code)
    socket.close(code, String(code))
  }
  function send(frame: HostFrame) {
    if (ended || !socket.isOpen()) return
    const text = JSON.stringify(frame)
    if (
      utf8Length(text) > HOST_LIMITS.outboundFrameBytes ||
      socket.bufferedBytes() + utf8Length(text) > limits.sendQueueBytes
    ) {
      close(4429)
      return
    }
    socket.send(text)
  }
  function refuse(code: HostCloseCode, reason: string) {
    ports.log?.('api.auth_failed', { reason })
    send({ type: 'error', code, message: String(code) })
    finish(code)
    queueMicrotask(() => socket.close(code, String(code)))
  }
  function accept(authentication: Authentication, challenge: string | undefined) {
    const initial = !client
    client = authentication.client
    caps = authentication.caps
    closeAt = authentication.closeAt
    clearTimeout(deadline)
    clearTimeout(expiry)
    expiry = setTimeout(() => close(4401), Math.max(0, authentication.closeAt - now()))
    if (initial && challenge !== undefined) {
      send(authentication.ready(challenge, connectionId))
      if (!ended) {
        const ready = {
          connectionId,
          trace,
          caps,
          socket,
          credentialLive: () => !ended && now() < closeAt,
          brainAccess: authentication.brainAccess,
          ...identity(authentication),
        }
        handler = ports.handler?.(ready)
        ports.onReady?.(ready)
        ports.log?.('api.connected', trace ? { trace } : {})
      }
    } else {
      if (authentication.brainAccess === undefined) handler?.renew(caps)
      else handler?.renew(caps, authentication.brainAccess)
      send({
        type: 'auth-renewed',
        grantExpiresAt: authentication.grantExpiresAt,
        capabilities: caps,
        ...(authentication.brainAccess ? { brainAccess: authentication.brainAccess } : {}),
      })
    }
  }
  function authenticate(token: string, challenge?: string) {
    return ports.authenticate.verify(token, challenge, {
      ended: () => ended,
      refuse,
      admit: (clientId) => ports.admit(clientId),
      accept: (authentication) => accept(authentication, challenge),
    })
  }
  socket.onClose((code) => finish(code))
  socket.onMessage((text) => {
    if (ended) return
    clearTimeout(idle)
    idle = setTimeout(() => close(4401), limits.idleCloseMs)
    if (utf8Length(text) > limits.inboundFrameBytes) return close(4400)
    const parsed = parseClientFrame(text)
    if (
      !client &&
      (!parsed.ok || parsed.frame.type !== 'auth' || parsed.frame.challenge === undefined)
    ) {
      close(4401)
      return
    }
    if (!parsed.ok) {
      if ('reply' in parsed && parsed.reply?.kind === 'receipt')
        send({
          type: 'receipt',
          receipt: {
            requestId: parsed.reply.requestId,
            status: 'rejected',
            code: parsed.reply.code,
          },
        })
      else if ('reply' in parsed && parsed.reply?.kind === 'result')
        send({
          type: 'result',
          id: parsed.reply.id,
          ok: false,
          error: { code: 'bad-request', message: 'bad-request' },
        })
      else close(4400)
      return
    }
    const frame = parsed.frame
    if (frame.type === 'auth') {
      if (!client) trace = frame.trace
      clearTimeout(deadline)
      if (checking) return close(4429)
      checking = true
      void authenticate(frame.grant, frame.challenge)
        .catch(() => {
          if (!ended) refuse(4401, 'verification')
        })
        .finally(() => {
          checking = false
        })
    } else if (frame.type === 'ping') send({ type: 'pong', at: frame.at })
    else if (handler) handler.handle(frame, caps)
    else unanswered(frame, send)
  })
  return {
    connectionId,
    close,
    rejectFrame: () => close(client ? 4400 : 4401),
    clientId: () => client?.id,
  }
}
