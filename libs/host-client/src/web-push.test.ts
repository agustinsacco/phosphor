import { describe, expect, it, vi } from 'vitest'
import { hostWebPushKey, registerWebPush, unregisterWebPush } from './web-push'

const KEY = 'B' + 'A'.repeat(86)
const subscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/phone',
  keys: {
    p256dh:
      'BLovIndJxi9rn_Q4YZsHtnESnX2ccbijmaIDmUM5wlGXFhzoviBVcfGYlIZIhlSuhQ5bE_LcnhZ9SvnLQkh2g_M',
    auth: 'EAY5CR185BofDMFkvMZw4Q',
  },
}
function connection(view: object = {}) {
  let generation = 1
  const c = {
    view: { state: 'ready', capabilities: ['sessions.read'], webPushKey: KEY, ...view },
    snapshot: () => c.view as never,
    incarnation: () => ({ generation }) as never,
    call: vi.fn(async (_method: string, _params?: unknown) => ({
      type: 'result' as const,
      id: 'x',
      ok: true as const,
      data: null,
    })),
    replace: () => generation++,
  }
  return c
}

describe('Host Web Push registration', () => {
  it('offers the key only on a ready connection that may read lanes', () => {
    expect(hostWebPushKey(connection())).toBe(KEY)
    expect(hostWebPushKey(connection({ state: 'reconnecting' }))).toBeUndefined()
    expect(hostWebPushKey(connection({ capabilities: [] }))).toBeUndefined()
    expect(hostWebPushKey(connection({ webPushKey: undefined }))).toBeUndefined()
    expect(hostWebPushKey(undefined)).toBeUndefined()
  })
  it('sends exactly the subscription and its keys, never extra fields', async () => {
    const c = connection()
    expect(await registerWebPush(c, subscription)).toBe(true)
    expect(c.call).toHaveBeenCalledWith('notifications.subscribe', subscription)
    expect(await registerWebPush(c, { ...subscription, expirationTime: null })).toBe(false)
    expect(await registerWebPush(connection({ webPushKey: undefined }), subscription)).toBe(false)
    expect(c.call).toHaveBeenCalledTimes(1)
  })
  it('trusts an answer only from the same socket, and an older Host is never asked', async () => {
    const c = connection()
    c.call.mockImplementationOnce(async () => {
      c.replace()
      return { type: 'result', id: 'x', ok: true, data: null }
    })
    expect(await registerWebPush(c, subscription)).toBe(false)
    c.call.mockResolvedValueOnce({
      type: 'result',
      id: 'x',
      ok: false,
      error: { code: 'unsupported', message: 'x' },
    } as never)
    expect(await unregisterWebPush(c, subscription.endpoint)).toBe(false)
    expect(await unregisterWebPush(c, subscription.endpoint)).toBe(true)
    expect(c.call).toHaveBeenLastCalledWith('notifications.unsubscribe', {
      endpoint: subscription.endpoint,
    })
    expect(await unregisterWebPush(c, 'https://evil.example/')).toBe(false)
  })
})
