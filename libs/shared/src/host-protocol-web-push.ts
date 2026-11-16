import { isUuid } from './control-api'
import { decodeBase64url } from './host-grant'
import { integer, label, member, record } from './host-protocol/primitives'
import type { LaneReceiptFacts } from './lane-receipt'

/**
 * Web Push from a Host to a browser that is closed: the device registers its push
 * subscription with each Host over the verified Host connection, and the Host encrypts
 * every message to it (RFC 8291) and signs its request (RFC 8292). Control stores nothing.
 */
export const WEB_PUSH_METHODS = ['notifications.subscribe', 'notifications.unsubscribe'] as const

export const WEB_PUSH_LIMITS = {
  /** Subscriptions one Host keeps; registering past it forgets the least recently registered. */
  subscriptions: 20,
  endpointChars: 2048,
  /** Plaintext bytes: one 4096-byte aes128gcm record leaves 3993, minus margin. */
  payloadBytes: 3072,
} as const

/** The only push services a Host will POST to. Anything else is refused at subscribe and send. */
export const WEB_PUSH_SERVICES = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
] as const
/** Windows push endpoints are regional subdomains of this one. */
export const WEB_PUSH_SERVICE_SUFFIX = '.notify.windows.com'

const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** An https endpoint on an allowlisted push service: no credentials, port or fragment. */
export function isPushServiceEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > WEB_PUSH_LIMITS.endpointChars) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash)
    return false
  const host = url.hostname
  if ((WEB_PUSH_SERVICES as readonly string[]).includes(host)) return true
  if (!host.endsWith(WEB_PUSH_SERVICE_SUFFIX)) return false
  const prefix = host.slice(0, -WEB_PUSH_SERVICE_SUFFIX.length)
  return prefix.split('.').every((part) => SUBDOMAIN.test(part))
}

/** An uncompressed P-256 point (65 bytes, 0x04 first) as canonical unpadded base64url. */
export function isP256PublicKey(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 87) return false
  const bytes = decodeBase64url(value)
  return bytes !== null && bytes.length === 65 && bytes[0] === 4
}

export interface WebPushSubscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

const exactKeys = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key))

/** `notifications.subscribe` params: exactly `{ endpoint, keys: { p256dh, auth } }`. */
export function parseWebPushSubscription(value: unknown): WebPushSubscription | null {
  if (!record(value) || !exactKeys(value, ['endpoint', 'keys'])) return null
  const { endpoint, keys } = value
  if (!isPushServiceEndpoint(endpoint) || !record(keys) || !exactKeys(keys, ['p256dh', 'auth']))
    return null
  const auth = typeof keys.auth === 'string' ? decodeBase64url(keys.auth) : null
  if (!isP256PublicKey(keys.p256dh) || auth?.length !== 16) return null
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth as string } }
}

/** `notifications.unsubscribe` params: exactly `{ endpoint }`. */
export function parseWebPushUnsubscribe(value: unknown): { endpoint: string } | null {
  return record(value) && exactKeys(value, ['endpoint']) && isPushServiceEndpoint(value.endpoint)
    ? { endpoint: value.endpoint }
    : null
}

export const WEB_PUSH_KINDS = ['finished', 'needs-input', 'failed'] as const

/** What a Host pushes: identifiers, the two labels and receipt facts. No excerpt, path or repository. */
export interface WebPushPayload {
  v: 1
  hostId: string
  laneId: string
  kind: (typeof WEB_PUSH_KINDS)[number]
  machine: string
  title: string
  receipt?: LaneReceiptFacts
}

function receiptFacts(v: unknown): LaneReceiptFacts | null {
  if (!record(v) || !exactKeys(v, ['outcome', 'durationMs', 'files', 'tests', 'artifacts']))
    return null
  if (
    !member(v.outcome, ['done', 'error']) ||
    (v.durationMs !== null && !integer(v.durationMs)) ||
    !integer(v.files) ||
    (v.tests !== null && !member(v.tests, ['passed', 'failed'])) ||
    !integer(v.artifacts)
  )
    return null
  return {
    outcome: v.outcome,
    durationMs: v.durationMs as number | null,
    files: v.files,
    tests: v.tests as LaneReceiptFacts['tests'],
    artifacts: v.artifacts,
  }
}

/** The decrypted push message, or null for anything out of shape. */
export function parseWebPushPayload(value: unknown): WebPushPayload | null {
  if (!record(value) || value.v !== 1) return null
  const keys = ['v', 'hostId', 'laneId', 'kind', 'machine', 'title']
  if (!exactKeys(value, value.receipt === undefined ? keys : [...keys, 'receipt'])) return null
  const receipt = value.receipt === undefined ? undefined : receiptFacts(value.receipt)
  if (
    !isUuid(value.hostId) ||
    !isUuid(value.laneId) ||
    !member(value.kind, WEB_PUSH_KINDS) ||
    !label(value.machine) ||
    !label(value.title) ||
    receipt === null
  )
    return null
  return {
    v: 1,
    hostId: value.hostId,
    laneId: value.laneId,
    kind: value.kind,
    machine: value.machine,
    title: value.title,
    ...(receipt ? { receipt } : {}),
  }
}
