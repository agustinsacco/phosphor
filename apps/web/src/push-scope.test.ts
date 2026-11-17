import { describe, expect, it } from 'vitest'
import { isPushScope, parsePushScope, pushScopePath } from './push-scope'

const CLIENT = '00000000-0000-4000-8000-000000000005'
const HOST = '00000000-0000-4000-8000-000000000006'

describe('Host push scopes', () => {
  it('are built only from two UUIDs, so no value can steer the path', () => {
    expect(pushScopePath(CLIENT, HOST)).toBe(`/push/${CLIENT}/${HOST}/`)
    for (const [client, host] of [
      [CLIENT, '../lanes'],
      [CLIENT, `${HOST}/x`],
      ['..', HOST],
      [CLIENT, ''],
      [CLIENT, `${HOST}?scope=/`],
    ])
      expect(pushScopePath(client!, host!), `${client} ${host}`).toBeUndefined()
  })
  it('parse back only from their exact shape', () => {
    expect(parsePushScope(`https://app.invalid/push/${CLIENT}/${HOST}/`)).toStrictEqual({
      clientId: CLIENT,
      hostId: HOST,
    })
    for (const scope of [
      'https://app.invalid/',
      `https://app.invalid/push/${HOST}/`,
      `https://app.invalid/push/${CLIENT}/${HOST}/extra/`,
      `https://app.invalid/push/${CLIENT}/not-a-host/`,
      'not a url',
    ])
      expect(parsePushScope(scope), scope).toBeUndefined()
  })
  it('mark push-only registrations apart from the app scope', () => {
    expect(isPushScope(`https://app.invalid/push/${CLIENT}/${HOST}/`)).toBe(true)
    expect(isPushScope('https://app.invalid/push/older/')).toBe(true)
    expect(isPushScope('https://app.invalid/')).toBe(false)
    expect(isPushScope('https://app.invalid/pushy/')).toBe(false)
    expect(isPushScope(undefined)).toBe(false)
  })
})
