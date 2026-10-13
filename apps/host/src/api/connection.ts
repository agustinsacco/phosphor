import { randomBytes, sign, verify, type KeyObject } from 'node:crypto'
import { CONTROL_LIMITS } from '@phosphor/shared/control-api'
import {
  checkGrantClaims,
  splitGrant,
  type GrantPayload,
  type GrantClient,
} from '@phosphor/shared/host-grant'
import {
  HOST_LIMITS,
  HOST_PROTOCOL_VERSION,
  helloProofMessage,
  parseClientFrame,
  utf8Length,
  type FrameSocket,
  type HostFrame,
  type HostCloseCode,
} from '@phosphor/shared/host-protocol'
import type { HostHello, HostCapability } from '@phosphor/shared/remote-host'
import type { Authority } from './authority'
import type { Keyset } from './keyset'

export type ApiLog = (event: string, fields: Record<string, string | number>) => void
export interface ReadyConnection {
  connectionId: string
  client: GrantClient
  caps: readonly HostCapability[]
  socket: FrameSocket
}
export interface ConnectionPorts {
  socket: FrameSocket
  authority: Authority
  keyset: Keyset
  origin: string
  hello: HostHello
  key: KeyObject
  admit(clientId: string): boolean
  ping?: () => void
  onReady?(connection: ReadyConnection): void
  onClose?(connectionId: string): void
  log?: ApiLog
  now?: () => number
  limits?: Partial<
    Record<
      | 'authTimeoutMs'
      | 'inboundFrameBytes'
      | 'connectionsPerClient'
      | 'pingIntervalMs'
      | 'idleCloseMs',
      number
    >
  >
}

export function hostProof(hello: HostHello, challenge: string, key: KeyObject) {
  return sign(
    null,
    Buffer.from(helloProofMessage(hello.hostId, hello.runtimeEpoch, challenge)),
    key,
  ).toString('base64url')
}

export function createConnection(ports: ConnectionPorts) {
  const { socket } = ports
  const now = ports.now ?? Date.now
  const limits = { ...HOST_LIMITS, ...ports.limits }
  for (const name of [
    'authTimeoutMs',
    'inboundFrameBytes',
    'connectionsPerClient',
    'pingIntervalMs',
    'idleCloseMs',
  ] as const)
    if (!Number.isSafeInteger(limits[name]) || limits[name] < 1 || limits[name] > HOST_LIMITS[name])
      throw new Error('Invalid limit')
  const connectionId = randomBytes(8).toString('hex')
  const started = now()
  let grant: GrantPayload | undefined
  let ended = false
  let checking = false
  let expiry: ReturnType<typeof setTimeout> | undefined
  const deadline = setTimeout(() => close(4401), limits.authTimeoutMs)
  let idle = setTimeout(() => close(4401), limits.idleCloseMs)
  const heartbeat = setInterval(() => ports.ping?.(), limits.pingIntervalMs)
  heartbeat.unref()
  const admittedAuthority = ports.authority.snapshot()
  const unsubscribe = ports.authority.onChange(() => {
    const authority = ports.authority.snapshot()
    if (
      !authority ||
      authority.owner !== admittedAuthority?.owner ||
      authority.epoch !== admittedAuthority?.epoch
    )
      close(4403)
    else if (
      grant &&
      (!authority ||
        grant.sub !== authority.owner ||
        grant.epoch !== authority.epoch ||
        authority.revokedSessions.has(grant.sid) ||
        authority.revokedClients.has(grant.client.id))
    )
      close(4403)
  })
  function finish(code: number) {
    if (ended) return
    ended = true
    clearTimeout(deadline)
    clearTimeout(expiry)
    clearInterval(heartbeat)
    clearTimeout(idle)
    unsubscribe()
    ports.onClose?.(connectionId)
    ports.log?.('api.closed', { connectionId, code, ms: Math.max(0, now() - started) })
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
      socket.bufferedBytes() + utf8Length(text) > HOST_LIMITS.sendQueueBytes
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
  async function authenticate(token: string, challenge?: string) {
    const parsed = splitGrant(token)
    if (!parsed.ok) return refuse(4401, 'token')
    const { payload, payloadBytes, signature } = parsed.value
    const key = await ports.keyset.get(payload.kid)
    if (ended) return
    if (!key || !verify(null, payloadBytes, key, signature)) return refuse(4401, 'signature')
    const authority = ports.authority.snapshot()
    if (!authority) return refuse(4403, 'authority')
    const failure = checkGrantClaims(
      payload,
      { ...authority, iss: ports.origin, hostId: ports.hello.hostId },
      now() / 1000,
      CONTROL_LIMITS.signatureSkewSec,
    )
    if (failure)
      return refuse(failure === 'expired' || failure === 'not-yet-valid' ? 4401 : 4403, failure)
    if (
      grant &&
      (grant.sub !== payload.sub ||
        grant.client.id !== payload.client.id ||
        challenge !== undefined)
    )
      return refuse(4403, 'identity')
    if (!grant && !ports.admit(payload.client.id)) return refuse(4429, 'connections')
    const initial = !grant
    grant = payload
    clearTimeout(deadline)
    clearTimeout(expiry)
    expiry = setTimeout(
      () => close(4401),
      Math.max(0, (payload.exp + CONTROL_LIMITS.signatureSkewSec) * 1000 - now()),
    )
    const grantExpiresAt = new Date(payload.exp * 1000).toISOString()
    if (initial && challenge !== undefined) {
      send({
        type: 'ready',
        protocolVersion: HOST_PROTOCOL_VERSION,
        hello: ports.hello,
        proof: hostProof(ports.hello, challenge, ports.key),
        connectionId,
        grantExpiresAt,
        client: payload.client,
        capabilities: [],
      })
      if (!ended) {
        ports.onReady?.({ connectionId, client: payload.client, caps: [], socket })
        ports.log?.('api.connected', { connectionId, clientId: payload.client.id })
      }
    } else send({ type: 'auth-renewed', grantExpiresAt })
  }
  socket.onClose((code) => finish(code))
  socket.onMessage((text) => {
    if (ended) return
    clearTimeout(idle)
    idle = setTimeout(() => close(4401), limits.idleCloseMs)
    if (utf8Length(text) > limits.inboundFrameBytes) return close(4400)
    const parsed = parseClientFrame(text)
    if (
      !grant &&
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
    else if (frame.type === 'subscribe')
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
  })
  return { connectionId, close, clientId: () => grant?.client.id }
}
