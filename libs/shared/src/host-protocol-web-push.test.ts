import { describe, expect, it } from 'vitest'
import {
  isPushServiceEndpoint,
  parseWebPushPayload,
  parseWebPushSubscription,
  parseWebPushUnsubscribe,
  WEB_PUSH_LIMITS,
} from './host-protocol-web-push'
import { pushNotice, attentionNotice } from './notifications'

const P256DH =
  'BLovIndJxi9rn_Q4YZsHtnESnX2ccbijmaIDmUM5wlGXFhzoviBVcfGYlIZIhlSuhQ5bE_LcnhZ9SvnLQkh2g_M'
const AUTH = 'EAY5CR185BofDMFkvMZw4Q'
const FCM = 'https://fcm.googleapis.com/fcm/send/abc:def'
const HOST = '00000000-0000-4000-8000-000000000006'
const LANE = '00000000-0000-4000-8000-000000000007'

describe('push service allowlist', () => {
  it('accepts https endpoints on the four push services', () => {
    for (const endpoint of [
      FCM,
      'https://fcm.googleapis.com/wp/token',
      'https://updates.push.services.mozilla.com/wpush/v2/token',
      'https://web.push.apple.com/QGr-token',
      'https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB',
      'https://db5p.notify.windows.com/w/?token=x',
    ])
      expect(isPushServiceEndpoint(endpoint), endpoint).toBe(true)
  })
  it('refuses every other destination, so a Host never POSTs elsewhere', () => {
    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/x',
      'https://user:pass@fcm.googleapis.com/fcm/send/x',
      'https://fcm.googleapis.com:8443/fcm/send/x',
      'https://fcm.googleapis.com/fcm/send/x#fragment',
      'https://fcm.googleapis.com.evil.example/fcm/send/x',
      'https://evilfcm.googleapis.com/fcm/send/x',
      'https://googleapis.com/fcm/send/x',
      'https://notify.windows.com/w/?token=x',
      'https://.notify.windows.com/w/',
      'https://evil.example/?.notify.windows.com',
      'https://evil_.notify.windows.com/w/',
      'https://127.0.0.1/push',
      'https://localhost/push',
      'https://[::1]/push',
      'file:///etc/passwd',
      'fcm.googleapis.com/fcm/send/x',
      `https://fcm.googleapis.com/${'x'.repeat(WEB_PUSH_LIMITS.endpointChars)}`,
      42,
      null,
    ])
      expect(isPushServiceEndpoint(endpoint), String(endpoint)).toBe(false)
  })
})

describe('notifications.subscribe params', () => {
  const valid = { endpoint: FCM, keys: { p256dh: P256DH, auth: AUTH } }
  it('accepts exactly an allowlisted endpoint and the two subscription keys', () => {
    expect(parseWebPushSubscription(valid)).toStrictEqual(valid)
  })
  it('refuses extra fields, other endpoints and malformed keys', () => {
    for (const params of [
      null,
      [],
      { ...valid, expirationTime: null },
      { ...valid, clientId: HOST },
      { endpoint: 'https://evil.example/push', keys: valid.keys },
      { endpoint: FCM, keys: { ...valid.keys, extra: 1 } },
      { endpoint: FCM, keys: { p256dh: P256DH } },
      { endpoint: FCM, keys: { p256dh: P256DH.slice(1), auth: AUTH } },
      { endpoint: FCM, keys: { p256dh: 'C' + P256DH.slice(1), auth: AUTH } },
      { endpoint: FCM, keys: { p256dh: P256DH, auth: AUTH + 'A' } },
      { endpoint: FCM, keys: { p256dh: P256DH, auth: AUTH.slice(0, 21) + 'B' } },
      { endpoint: FCM, keys: { p256dh: P256DH, auth: 7 } },
    ])
      expect(parseWebPushSubscription(params), JSON.stringify(params)).toBeNull()
  })
})

describe('notifications.unsubscribe params', () => {
  it('names exactly one allowlisted endpoint', () => {
    expect(parseWebPushUnsubscribe({ endpoint: FCM })).toStrictEqual({ endpoint: FCM })
    expect(parseWebPushUnsubscribe({ endpoint: FCM, clientId: HOST })).toBeNull()
    expect(parseWebPushUnsubscribe({ endpoint: 'https://evil.example/' })).toBeNull()
    expect(parseWebPushUnsubscribe(FCM)).toBeNull()
  })
})

describe('push payload', () => {
  const payload = {
    v: 1,
    hostId: HOST,
    laneId: LANE,
    kind: 'finished',
    machine: 'Studio',
    title: 'Fix the build',
    receipt: { outcome: 'done', durationMs: 65_000, files: 2, tests: 'passed', artifacts: 0 },
  } as const
  it('parses identifiers, labels and receipt facts only', () => {
    expect(parseWebPushPayload(payload)).toStrictEqual(payload)
    const { receipt: _receipt, ...bare } = payload
    expect(parseWebPushPayload({ ...bare, kind: 'needs-input' })).toStrictEqual({
      ...bare,
      kind: 'needs-input',
    })
  })
  it('refuses excerpts, paths, unknown kinds and other versions', () => {
    for (const value of [
      { ...payload, v: 2 },
      { ...payload, kind: 'routine-finished' },
      { ...payload, hostId: 'host' },
      { ...payload, title: '' },
      { ...payload, title: 'a\nb' },
      { ...payload, excerpt: 'secret' },
      { ...payload, receipt: { ...payload.receipt, excerpt: 'secret' } },
      { ...payload, receipt: { ...payload.receipt, repository: 'repo' } },
      { ...payload, receipt: { ...payload.receipt, files: -1 } },
      { ...payload, receipt: null },
    ])
      expect(parseWebPushPayload(value), JSON.stringify(value)).toBeNull()
  })
  it('words the notice exactly as the page does for the same attention', () => {
    const parsed = parseWebPushPayload(payload)!
    expect(pushNotice(parsed)).toStrictEqual(
      attentionNotice('Studio', {
        hostId: HOST,
        laneId: LANE,
        kind: 'finished',
        title: 'Fix the build',
        receipt: parsed.receipt,
      }),
    )
    expect(pushNotice(parsed)).toStrictEqual({
      title: 'Studio · Fix the build',
      body: 'Done in 1m 5s · 2 files changed · tests pass',
      route: { hostId: HOST, laneId: LANE },
    })
  })
})
