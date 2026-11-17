import {
  parseWebPushSubscription,
  parseWebPushUnsubscribe,
} from '@phosphor/shared/host-protocol-web-push'
import type { createHostConnection } from './connection'

type Connection = Pick<ReturnType<typeof createHostConnection>, 'snapshot' | 'incarnation' | 'call'>

/** The Host's VAPID key, when this connection may register the device: ready, with `sessions.read`. */
export function hostWebPushKey(connection: Connection | undefined): string | undefined {
  const view = connection?.snapshot()
  return view?.state === 'ready' && view.capabilities.includes('sessions.read')
    ? view.webPushKey
    : undefined
}

/** True only when the same Host connection confirmed the call; a replaced socket proves nothing. */
async function confirmed(connection: Connection, method: string, params: unknown) {
  const generation = connection.incarnation().generation
  const result = await connection.call(method, params)
  return result.ok && connection.incarnation().generation === generation
}

/** Register this device's push subscription with one Host, which then pushes its lanes' attention. */
export async function registerWebPush(connection: Connection, subscription: unknown) {
  const params = parseWebPushSubscription(subscription)
  return params && hostWebPushKey(connection)
    ? confirmed(connection, 'notifications.subscribe', params)
    : false
}

/** Ask one Host to forget this device's subscription. */
export async function unregisterWebPush(connection: Connection, endpoint: string) {
  const params = parseWebPushUnsubscribe({ endpoint })
  return params && hostWebPushKey(connection)
    ? confirmed(connection, 'notifications.unsubscribe', params)
    : false
}
