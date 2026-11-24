import { isUuid } from '@phosphor/shared/control-api'
import {
  parseWebPushSubscription,
  WEB_PUSH_LIMITS,
  type WebPushSubscription,
} from '@phosphor/shared/host-protocol-web-push'
import { atomicRecord, readBounded } from '@phosphor/session-runtime/host-install/files'

/**
 * One device's registration, bound to the client, owner and enrollment epoch that made it.
 * Every subscribe stores a new row, even for the same endpoint, so a row is one registration.
 */
export interface StoredPushSubscription {
  clientId: string
  owner: string
  epoch: number
  subscription: WebPushSubscription
  registeredAt: number
}
export interface PushAuthority {
  owner: string
  epoch: number
  revokedClients: ReadonlySet<string>
}

const FILE_BYTES = 128 * 1024

function parseStored(value: unknown): StoredPushSubscription | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const subscription = parseWebPushSubscription(v.subscription)
  return subscription &&
    isUuid(v.clientId) &&
    typeof v.owner === 'string' &&
    v.owner.length > 0 &&
    v.owner.length <= 256 &&
    Number.isSafeInteger(v.epoch) &&
    Number.isSafeInteger(v.registeredAt)
    ? {
        clientId: v.clientId,
        owner: v.owner,
        epoch: v.epoch as number,
        subscription,
        registeredAt: v.registeredAt as number,
      }
    : null
}

function load(path: string, hostId: string): StoredPushSubscription[] {
  let value: unknown
  try {
    value = JSON.parse(readBounded(path, FILE_BYTES))
  } catch {
    // Missing is empty; anything unreadable starts empty too, and the next save replaces it.
    return []
  }
  if (!value || typeof value !== 'object') return []
  const file = value as Record<string, unknown>
  // Another enrollment's devices never receive this one's lanes.
  if (file.version !== 1 || file.hostId !== hostId || !Array.isArray(file.subscriptions)) return []
  return file.subscriptions
    .slice(0, WEB_PUSH_LIMITS.subscriptions)
    .flatMap((entry) => parseStored(entry) ?? [])
}

/** At most `WEB_PUSH_LIMITS.subscriptions`, in the Host's private state directory (0600). */
export function createPushSubscriptions(options: { path: string; hostId: string }) {
  let rows = load(options.path, options.hostId)
  const save = () =>
    atomicRecord(options.path, { version: 1, hostId: options.hostId, subscriptions: rows }, 0o600)
  const replace = (next: StoredPushSubscription[]) => {
    if (next.length === rows.length && next.every((row, i) => row === rows[i])) return false
    rows = next
    save()
    return true
  }
  return {
    list: (): readonly StoredPushSubscription[] => rows,
    /** Whether this registration is still stored; a later one for its endpoint is another row. */
    holds: (row: StoredPushSubscription): boolean => rows.includes(row),
    /** A client keeps one registration; re-registering an endpoint moves it to this client. */
    subscribe(row: StoredPushSubscription) {
      const others = rows.filter(
        (r) => r.clientId !== row.clientId && r.subscription.endpoint !== row.subscription.endpoint,
      )
      // Past the bound, the least recently registered device is forgotten.
      const kept = others
        .sort((a, b) => a.registeredAt - b.registeredAt)
        .slice(Math.max(0, others.length - (WEB_PUSH_LIMITS.subscriptions - 1)))
      replace([...kept, row])
    },
    /** Only the caller's own registration; another client's is never touched. */
    unsubscribe(clientId: string, endpoint: string) {
      replace(rows.filter((r) => r.clientId !== clientId || r.subscription.endpoint !== endpoint))
    },
    /** The push service says the endpoint is gone (404/410). */
    remove(endpoint: string) {
      replace(rows.filter((r) => r.subscription.endpoint !== endpoint))
    },
    /** Revoked clients, another owner or another enrollment epoch lose their registrations. */
    retain(authority: PushAuthority) {
      return replace(rows.filter((r) => current(r, authority)))
    },
  }
}
export type PushSubscriptions = ReturnType<typeof createPushSubscriptions>

export function current(row: StoredPushSubscription, authority: PushAuthority): boolean {
  return (
    row.owner === authority.owner &&
    row.epoch === authority.epoch &&
    !authority.revokedClients.has(row.clientId)
  )
}
