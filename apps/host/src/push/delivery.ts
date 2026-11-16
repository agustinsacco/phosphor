import {
  isPushServiceEndpoint,
  type WebPushSubscription,
} from '@phosphor/shared/host-protocol-web-push'
import { encryptPushMessage } from './encryption'

export const PUSH_DELIVERY_LIMITS = {
  /** Messages waiting to send or retry; past it the oldest waiting one is dropped. */
  queue: 64,
  concurrency: 4,
  attempts: 4,
  requestMs: 10_000,
  /** Waits before the second, third and fourth attempts; a longer Retry-After wins, up to the cap. */
  backoffMs: [5_000, 30_000, 120_000],
  retryAfterCapMs: 600_000,
}

export interface PushMessage {
  /** The device's push endpoint: with `topic`, which messages replace each other. */
  endpoint: string
  /**
   * The device's subscription now, asked before every request and before a retry waits:
   * undefined once it may no longer receive this message (unsubscribed, revoked, another
   * owner) or a newer message for its lane overtook it, and the message is then dropped.
   */
  recipient(): WebPushSubscription | undefined
  payload: Buffer
  /** Seconds the push service may hold the message for an offline device. */
  ttl: number
  urgency: 'high' | 'normal'
  /** Replaces an undelivered message with the same topic, at the push service and here. */
  topic: string
}
interface Job {
  message: PushMessage
  attempt: number
  dueAt: number
}
export interface PushDeliveryPorts {
  fetch: typeof fetch
  authorization(endpoint: string): string
  /** The push service says the subscription is gone. */
  gone(endpoint: string): void
  now(): number
  log(event: string, fields: Record<string, string | number>): void
  limits?: Partial<typeof PUSH_DELIVERY_LIMITS>
}

/** Messages with one key replace each other and are sent one at a time, in order. */
const keyOf = (message: PushMessage) => `${message.endpoint} ${message.topic}`

function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get('retry-after'))
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0
}

/** A newer message for the same device and lane replaces a waiting one. False when one was dropped. */
function queueJob(queue: Job[], job: Job, limit: number): boolean {
  const key = keyOf(job.message)
  const same = queue.findIndex((queued) => keyOf(queued.message) === key)
  let kept = true
  if (same >= 0) queue.splice(same, 1)
  else if (queue.length >= limit) {
    queue.shift()
    kept = false
  }
  queue.push(job)
  return kept
}

function retryDelay(limits: typeof PUSH_DELIVERY_LIMITS, job: Job, after: number): number {
  const backoff = limits.backoffMs[Math.min(job.attempt, limits.backoffMs.length - 1)] ?? 0
  return Math.min(Math.max(backoff, after), limits.retryAfterCapMs)
}

/**
 * A failed job's next attempt, `'failed'` once it is out of attempts, or undefined when it
 * no longer goes: its recipient is gone, or a message with its key was queued while it was
 * in flight, which is newer and wins.
 */
function nextAttempt(
  limits: typeof PUSH_DELIVERY_LIMITS,
  queue: readonly Job[],
  job: Job,
  after: number,
  now: number,
): Job | 'failed' | undefined {
  const key = keyOf(job.message)
  if (queue.some((queued) => keyOf(queued.message) === key) || !job.message.recipient())
    return undefined
  if (job.attempt + 1 >= limits.attempts) return 'failed'
  return { ...job, attempt: job.attempt + 1, dueAt: now + retryDelay(limits, job, after) }
}

/** Drops every waiting message for an endpoint the push service says is gone. */
function forgetEndpoint(queue: Job[], endpoint: string) {
  for (let i = queue.length - 1; i >= 0; i--)
    if (queue[i]!.message.endpoint === endpoint) queue.splice(i, 1)
}

/**
 * A bounded, best-effort sender. `send` only queues, so a lane's publication never waits
 * on a push service; requests run in the background, never follow redirects, and never
 * go anywhere but an allowlisted push service. Nothing about the message is logged.
 */
export function createPushDelivery(ports: PushDeliveryPorts) {
  const limits = { ...PUSH_DELIVERY_LIMITS, ...ports.limits }
  const queue: Job[] = []
  /** Keys with a request in flight: a later message for the same device and lane waits for it. */
  const busy = new Set<string>()
  const aborts = new Set<AbortController>()
  let active = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false

  function schedule() {
    clearTimeout(timer)
    timer = undefined
    const ready = queue.filter((job) => !busy.has(keyOf(job.message)))
    if (closed || !ready.length || active >= limits.concurrency) return
    const next = Math.min(...ready.map((job) => job.dueAt))
    timer = setTimeout(pump, Math.max(0, next - ports.now()))
    timer.unref()
  }
  function pump() {
    while (!closed && active < limits.concurrency) {
      const now = ports.now()
      const index = queue.findIndex((job) => job.dueAt <= now && !busy.has(keyOf(job.message)))
      if (index < 0) break
      const [job] = queue.splice(index, 1)
      const key = keyOf(job!.message)
      active++
      busy.add(key)
      void attempt(job!).finally(() => {
        active--
        busy.delete(key)
        pump()
      })
    }
    schedule()
  }
  const enqueue = (job: Job) => {
    if (!queueJob(queue, job, limits.queue)) ports.log('push.dropped', { reason: 'queue' })
  }
  function retry(job: Job, after: number, reason: string | number) {
    const next = nextAttempt(limits, queue, job, after, ports.now())
    if (next === 'failed') ports.log('push.failed', { reason })
    else if (next) enqueue(next)
  }
  function gone(endpoint: string) {
    forgetEndpoint(queue, endpoint)
    ports.gone(endpoint)
  }
  async function attempt(job: Job) {
    const subscription = job.message.recipient()
    if (!subscription) return
    const abort = new AbortController()
    aborts.add(abort)
    try {
      const outcome = await post(ports, limits.requestMs, subscription, job.message, abort)
      if (outcome.kind === 'gone') gone(job.message.endpoint)
      else if (outcome.kind === 'retry' && !closed) retry(job, outcome.after, outcome.reason)
      else if (outcome.kind === 'refused') ports.log('push.refused', outcome.fields)
    } finally {
      aborts.delete(abort)
    }
  }
  return {
    send(message: PushMessage) {
      if (closed) return
      enqueue({ message, attempt: 0, dueAt: ports.now() })
      // Encryption and the request start on a later turn, never inside the caller's.
      schedule()
    },
    pending: () => queue.length + active,
    close() {
      closed = true
      clearTimeout(timer)
      queue.length = 0
      for (const abort of aborts) abort.abort()
    },
  }
}

type Outcome =
  | { kind: 'sent' | 'gone' }
  | { kind: 'retry'; after: number; reason: string | number }
  | { kind: 'refused'; fields: Record<string, number> }

/** One request. Its body is encrypted afresh, so a retry never reuses a key or salt. */
async function post(
  ports: Pick<PushDeliveryPorts, 'fetch' | 'authorization'>,
  requestMs: number,
  subscription: WebPushSubscription,
  message: PushMessage,
  abort: AbortController,
): Promise<Outcome> {
  const { payload, ttl, urgency, topic } = message
  // Checked again at send time: a stored endpoint never widens where the Host connects.
  if (!isPushServiceEndpoint(subscription.endpoint)) return { kind: 'refused', fields: {} }
  const deadline = setTimeout(() => abort.abort(), requestMs)
  deadline.unref()
  try {
    const body = encryptPushMessage(payload, {
      p256dh: Buffer.from(subscription.keys.p256dh, 'base64url'),
      auth: Buffer.from(subscription.keys.auth, 'base64url'),
    })
    const response = await ports.fetch(subscription.endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: abort.signal,
      headers: {
        authorization: ports.authorization(subscription.endpoint),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(ttl),
        urgency,
        topic,
      },
      body,
    })
    await response.body?.cancel().catch(() => {})
    const status = response.status
    if (status === 404 || status === 410) return { kind: 'gone' }
    if (status === 429 || status >= 500)
      return { kind: 'retry', after: retryAfterMs(response), reason: status }
    return status >= 200 && status < 300
      ? { kind: 'sent' }
      : { kind: 'refused', fields: { status } }
  } catch {
    return { kind: 'retry', after: 0, reason: 'network' }
  } finally {
    clearTimeout(deadline)
  }
}
