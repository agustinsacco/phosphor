import { createHash } from 'node:crypto'
import type { AttentionEvent } from '@phosphor/shared/host-protocol'
import {
  parseWebPushPayload,
  parseWebPushSubscription,
  parseWebPushUnsubscribe,
  WEB_PUSH_KINDS,
  WEB_PUSH_LIMITS,
  WEB_PUSH_METHODS,
  type WebPushPayload,
} from '@phosphor/shared/host-protocol-web-push'
import {
  receiptExpected,
  receiptFactsOf,
  receiptForEvent,
  receiptWithin,
} from '@phosphor/shared/lane-receipt'
import type { Authority } from '../api/authority'
import type { FeatureOutcome, HostFeature } from '../features/feature'
import type { CallOutcome } from '../lanes/service'
import type { LanesTopic } from '../lanes/stream'
import { createPushDelivery, type PushDeliveryPorts } from './delivery'
import { isUsablePushKey } from './encryption'
import { createPushSubscriptions, current, type PushSubscriptions } from './subscriptions'
import { createVapidSigner, loadVapidKey, type VapidKey } from './vapid'

/** How long a push service holds a message for a device that is off. */
export const WEB_PUSH_TTL_SECONDS = 6 * 3600
/** Attention events reading a receipt at once; past it a push goes without receipt facts. */
const RECEIPT_READS = 32

export interface WebPushOptions {
  identityDirectory: string
  /** The Host's private state directory: `web-push.json` holds the subscriptions. */
  subscriptionsPath: string
  uid: number | undefined
  hostId: string
  /** The Host's machine label, as enrolled. */
  machine: string
  /** The Control origin, the VAPID contact. */
  subject: string
  authority: Pick<Authority, 'snapshot' | 'onChange'>
  lanesTopic: Pick<LanesTopic, 'listen'>
  /** The lane's `lane.receipt` call, as clients read it. */
  receipt(laneId: string): Promise<CallOutcome>
  fetch?: typeof fetch
  now?: () => number
  log(event: string, fields: Record<string, string | number>): void
  delivery?: PushDeliveryPorts['limits']
}

const refusal = (code: 'bad-request' | 'forbidden'): FeatureOutcome => ({
  ok: false,
  error: { code, message: code },
})
const pushKind = (kind: string): kind is WebPushPayload['kind'] =>
  (WEB_PUSH_KINDS as readonly string[]).includes(kind)
/** At most 32 URL-safe characters; one lane's newer message replaces its older one. */
export const laneTopic = (laneId: string): string =>
  createHash('sha256').update(laneId).digest('base64url').slice(0, 32)

/**
 * Each lane's newest attention while it is announced: an older one still reading its
 * receipt then never sends, so it cannot replace the newer one on the device.
 */
function laneAnnouncements() {
  const latest = new Map<string, number>()
  let sequence = 0
  return {
    begin(laneId: string) {
      latest.set(laneId, ++sequence)
      return sequence
    },
    newest: (laneId: string, n: number) => latest.get(laneId) === n,
    end(laneId: string, n: number) {
      if (latest.get(laneId) === n) latest.delete(laneId)
    },
  }
}

/** The device's payload, or undefined when the device would refuse it: then nothing is sent. */
function pushPayload(
  options: Pick<WebPushOptions, 'hostId' | 'machine'>,
  event: AttentionEvent,
  kind: WebPushPayload['kind'],
  receipt: WebPushPayload['receipt'],
): Buffer | undefined {
  const payload: WebPushPayload = {
    v: 1,
    hostId: options.hostId,
    laneId: event.laneId,
    kind,
    machine: options.machine,
    title: event.title ?? 'Untitled lane',
    ...(receipt ? { receipt } : {}),
  }
  const bytes = Buffer.from(JSON.stringify(payload))
  // The device parses with the same contract; anything it would refuse is never sent.
  return bytes.length <= WEB_PUSH_LIMITS.payloadBytes && parseWebPushPayload(payload)
    ? bytes
    : undefined
}

/** The subscription a queued message may still go to: same client and endpoint, still current. */
function storedRecipient(
  authority: WebPushOptions['authority'],
  subscriptions: PushSubscriptions,
  clientId: string,
  endpoint: string,
) {
  const snapshot = authority.snapshot()
  const row =
    snapshot &&
    subscriptions
      .list()
      .find((r) => r.clientId === clientId && r.subscription.endpoint === endpoint)
  return row && current(row, snapshot) ? row.subscription : undefined
}

/** The Host's Web Push, or undefined when its key cannot be loaded: the Host then runs without it. */
export async function startHostWebPush(options: WebPushOptions) {
  try {
    return createHostWebPush(options, await loadVapidKey(options.identityDirectory, options.uid))
  } catch {
    options.log('push.unavailable', {})
    return undefined
  }
}
export type HostWebPush = ReturnType<typeof createHostWebPush>

export function createHostWebPush(options: WebPushOptions, key: VapidKey) {
  const now = options.now ?? Date.now
  const subscriptions = createPushSubscriptions({
    path: options.subscriptionsPath,
    hostId: options.hostId,
  })
  const count = () => ({ subscriptions: subscriptions.list().length })
  const delivery = createPushDelivery({
    fetch: options.fetch ?? globalThis.fetch,
    authorization: createVapidSigner(key, options.subject, now),
    gone: (endpoint) => {
      subscriptions.remove(endpoint)
      options.log('push.gone', count())
    },
    now,
    log: options.log,
    limits: options.delivery,
  })
  const receiptFacts = receiptReader(options.receipt)
  const announcements = laneAnnouncements()
  async function announce(event: AttentionEvent, kind: WebPushPayload['kind'], n: number) {
    const receipt = await receiptFacts(event)
    // A newer attention for the lane came while the receipt was read: it is the one to show.
    if (!announcements.newest(event.laneId, n)) return
    const bytes = pushPayload(options, event, kind, receipt)
    if (!bytes) return options.log('push.dropped', { reason: 'payload' })
    // Fail closed: no current owner and epoch, no push.
    const authority = options.authority.snapshot()
    if (!authority) return
    for (const { clientId, subscription } of subscriptions
      .list()
      .filter((r) => current(r, authority)))
      delivery.send({
        endpoint: subscription.endpoint,
        // Revoked, unsubscribed or ownerless before it is sent or retried: dropped.
        recipient: () =>
          storedRecipient(options.authority, subscriptions, clientId, subscription.endpoint),
        payload: bytes,
        ttl: WEB_PUSH_TTL_SECONDS,
        urgency: kind === 'needs-input' ? 'high' : 'normal',
        topic: laneTopic(event.laneId),
      })
  }
  const offTopic = options.lanesTopic.listen((frame) => {
    // Called inside the lane's publication: only start the work, never wait on it.
    if (frame?.type !== 'attention' || !subscriptions.list().length) return
    const { event } = frame
    if (!pushKind(event.kind)) return
    const n = announcements.begin(event.laneId)
    void announce(event, event.kind, n)
      .catch(() => options.log('push.dropped', { reason: 'error' }))
      .finally(() => announcements.end(event.laneId, n))
  })
  const offAuthority = options.authority.onChange(() => {
    const authority = options.authority.snapshot()
    if (authority && subscriptions.retain(authority)) options.log('push.revoked', count())
  })
  const feature = subscriptionFeature(options, subscriptions, now, count)
  return {
    publicKey: key.publicKey,
    feature,
    close() {
      offTopic()
      offAuthority()
      delivery.close()
    },
  }
}

/** `notifications.subscribe` / `unsubscribe`: a device registers only itself. */
function subscriptionFeature(
  options: Pick<WebPushOptions, 'authority' | 'log'>,
  subscriptions: PushSubscriptions,
  now: () => number,
  count: () => { subscriptions: number },
): HostFeature {
  return {
    capability: 'sessions.read',
    methods: WEB_PUSH_METHODS,
    clientScoped: true,
    async call(method, params, _authorized, clientId) {
      // The client comes from the connection's grant, never from params.
      if (!clientId) return refusal('forbidden')
      if (method === 'notifications.unsubscribe') {
        const parsed = parseWebPushUnsubscribe(params)
        if (!parsed) return refusal('bad-request')
        subscriptions.unsubscribe(clientId, parsed.endpoint)
        return { ok: true, data: null }
      }
      const subscription = parseWebPushSubscription(params)
      if (!subscription || !isUsablePushKey(Buffer.from(subscription.keys.p256dh, 'base64url')))
        return refusal('bad-request')
      const authority = options.authority.snapshot()
      if (!authority || authority.revokedClients.has(clientId)) return refusal('forbidden')
      const { owner, epoch } = authority
      subscriptions.subscribe({ clientId, owner, epoch, subscription, registeredAt: now() })
      options.log('push.subscribed', count())
      return { ok: true, data: null }
    },
  }
}

/** The facts of the run an event announces, waited for as clients wait, at most 32 at once. */
function receiptReader(receipt: WebPushOptions['receipt']) {
  let reading = 0
  return async (event: AttentionEvent) => {
    if (!receiptExpected(event) || reading >= RECEIPT_READS) return undefined
    reading++
    try {
      const read = receipt(event.laneId).then((o) => (o.ok ? o.data : undefined))
      const matched = receiptForEvent(event, await receiptWithin(read.catch(() => undefined)))
      return matched ? receiptFactsOf(matched) : undefined
    } finally {
      reading--
    }
  }
}
