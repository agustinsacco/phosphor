import type { HostAttention } from './ipc'
import type { GhPrRef } from './models'
import { isPrRef, prKey } from './github-pr-refs'
import { receiptSummary, type LaneReceipt, type LaneReceiptFacts } from './lane-receipt'
import type { WebPushPayload } from './host-protocol-web-push'

/** Shared with Web Push: opaque IDs only; PR focus opens the lane's inspector, never a URL/path. */
export interface NotificationRoute {
  hostId: string
  laneId: string
  pr?: GhPrRef
}
export interface NativeNotice {
  title: string
  body: string
  /** Stable lane/PR identity; updates replace the previous native notification. */
  key?: string
  route?: NotificationRoute
}
const ID = /^[a-zA-Z0-9_-]{1,256}$/

export function parseNotificationRoute(value: unknown): NotificationRoute | undefined {
  if (!value || typeof value !== 'object') return undefined
  const route = value as Record<string, unknown>
  if (
    typeof route.hostId !== 'string' ||
    !ID.test(route.hostId) ||
    typeof route.laneId !== 'string' ||
    !ID.test(route.laneId) ||
    (route.pr !== undefined && !isPrRef(route.pr))
  )
    return undefined
  return {
    hostId: route.hostId,
    laneId: route.laneId,
    ...(route.pr ? { pr: route.pr as GhPrRef } : {}),
  }
}

type NoticeAttention = Pick<HostAttention, 'hostId' | 'laneId' | 'kind' | 'title'> & {
  receipt?: LaneReceipt | LaneReceiptFacts
}

/** Receipt facts only: reply excerpts, repositories, branches and paths stay off the lock screen. */
export function attentionNotice(machine: string, attention: NoticeAttention): NativeNotice {
  return {
    title: `${machine} · ${attention.title}`,
    body: attention.receipt
      ? receiptSummary(attention.receipt)
      : attention.kind === 'failed'
        ? 'Stopped'
        : attention.kind === 'finished'
          ? 'Done'
          : attention.kind,
    route: { hostId: attention.hostId, laneId: attention.laneId },
  }
}

/** A Host's Web Push message, worded and routed exactly as the page's own attention notice. */
export function pushNotice(payload: WebPushPayload): NativeNotice {
  return attentionNotice(payload.machine, payload)
}

/** One payload constructor for page delivery and service-worker/Web Push delivery. */
export function notificationPayload(notice: NativeNotice) {
  const route = parseNotificationRoute(notice.route)
  const key =
    notice.key ??
    (route?.pr
      ? `pr:${prKey(route.pr)}`
      : route
        ? `lane:${route.hostId}:${route.laneId}`
        : 'general')
  return {
    title: notice.title,
    options: {
      body: notice.body,
      tag: `phosphor:${key}`,
      icon: '/icons/icon-192.png',
      data: { type: 'phosphor-notification', ...(route ? { route } : {}) },
    },
  }
}

export function notificationPath(route?: NotificationRoute): string {
  if (!route) return '/lanes'
  const path = `/lanes/${route.hostId}/${route.laneId}/chat`
  return route.pr ? `${path}?notificationPr=${encodeURIComponent(JSON.stringify(route.pr))}` : path
}
