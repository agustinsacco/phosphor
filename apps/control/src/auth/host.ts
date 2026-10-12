import { createHash, createPublicKey, verify } from 'node:crypto'
import {
  HOST_HEADERS,
  hostSigningString,
  isNonce,
  isPublicKey,
  isSignature,
  isUuid,
  parseTimestamp,
  withinSkew,
} from '@phosphor/shared/control-api'
import type { MiddlewareHandler } from 'hono'
import { ControlFailure, rawTarget, unsafeRawTarget, type Env } from '../http'
import type { NonceCache } from '../limits'

export interface HostAuthDeps {
  clock: () => number
  nonces: NonceCache
  hostKey: (hostId: string) => Promise<string | 'gone'>
}
export async function authenticateHost(
  request: Request,
  body: Uint8Array,
  deps: HostAuthDeps,
  mode: 'key' | 'host',
  target = new URL(request.url).pathname + new URL(request.url).search,
) {
  const key = request.headers.get(HOST_HEADERS.key)
  const host = request.headers.get(HOST_HEADERS.host)
  const timestamp = request.headers.get(HOST_HEADERS.timestamp)
  const nonce = request.headers.get(HOST_HEADERS.nonce)
  const signature = request.headers.get(HOST_HEADERS.signature)
  const seconds = parseTimestamp(timestamp)
  const url = new URL(request.url)
  if (
    unsafeRawTarget(target) ||
    target !== url.pathname ||
    url.search ||
    url.hash ||
    Boolean(key) === Boolean(host) ||
    (mode === 'key' ? !isPublicKey(key) || host !== null : !isUuid(host) || key !== null) ||
    seconds === null ||
    !withinSkew(seconds, deps.clock()) ||
    !isNonce(nonce) ||
    !isSignature(signature) ||
    timestamp === null
  )
    throw new ControlFailure('unauthenticated')
  const identity = mode === 'key' ? key : host
  if (identity === null) throw new ControlFailure('unauthenticated')
  const publicKey = mode === 'key' ? key : await deps.hostKey(identity)
  if (publicKey === 'gone') throw new ControlFailure('gone')
  if (!isPublicKey(publicKey)) throw new ControlFailure('unavailable')
  // RFC 8410 SubjectPublicKeyInfo wraps the raw Ed25519 key with this prefix.
  const spki = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    Buffer.from(publicKey, 'base64url'),
  ])
  const input = hostSigningString({
    method: request.method,
    path: target,
    identity,
    timestamp,
    nonce,
    bodySha256: createHash('sha256').update(body).digest('hex'),
  })
  if (
    !verify(
      null,
      Buffer.from(input),
      createPublicKey({ key: spki, format: 'der', type: 'spki' }),
      Buffer.from(signature, 'base64url'),
    )
  )
    throw new ControlFailure('unauthenticated')
  if (!deps.nonces.accept(identity, nonce)) throw new ControlFailure('unauthenticated')
  return identity
}
export function hostGuard(deps: HostAuthDeps, mode: 'key' | 'host'): MiddlewareHandler<Env> {
  return async (c, next) => {
    const identity = await authenticateHost(
      c.req.raw,
      c.get('rawBody'),
      deps,
      mode,
      rawTarget(c.req.raw, c.env),
    )
    if (mode === 'host') c.set('actor', `host:${identity}`)
    await next()
  }
}
