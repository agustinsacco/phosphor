import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CONTROL_ROUTES, HOST_HEADERS, formatKeyFingerprint } from '@phosphor/shared/control-api'
import {
  controlTransport,
  controlTransportState,
  hostId,
  serverView,
  timestamp,
  type ControlMode,
} from './machine-transport'

const url = (path: string) => `https://example.com${path}`
const enrolled = { headers: { [HOST_HEADERS.host]: hostId } }
const other = { headers: { [HOST_HEADERS.host]: 'someone-else' } }
function transport(clock = 1000) {
  const state = controlTransportState(clock)
  return { state, fetch: controlTransport(state) }
}

describe('controlTransportState', () => {
  it('starts ok, with no calls or polls and an approval for the enrolled host', () => {
    expect(controlTransportState(5)).toEqual({
      clock: 5,
      calls: [],
      polls: 0,
      mode: 'ok',
      finalMode: 'ok',
      answer: { status: 'approved', hostId, label: 'bee1', owner: { login: 'me' } },
      creation: {},
    })
    expect(serverView).toMatchObject({ hostId, enrolledAt: timestamp })
  })

  it('never shares mutable state between transports', () => {
    const first = controlTransportState(0)
    const second = controlTransportState(0)
    expect(first.calls).not.toBe(second.calls)
    expect(first.answer).not.toBe(second.answer)
    expect(first.creation).not.toBe(second.creation)
  })
})

describe('controlTransport recording', () => {
  it('records each request with the clock at send time, before any failure', async () => {
    const { state, fetch } = transport()
    state.mode = 'offline'
    await expect(
      fetch(url(CONTROL_ROUTES.me), { method: 'GET', headers: { a: 'b' } }),
    ).rejects.toThrow('transport contains secret')
    state.clock = 2000
    state.mode = 'ok'
    await fetch(url(CONTROL_ROUTES.hostHeartbeat), { method: 'POST', body: '{}' })
    expect(state.calls.map(({ path, method, body, at }) => ({ path, method, body, at }))).toEqual([
      { path: CONTROL_ROUTES.me, method: 'GET', body: '', at: 1000 },
      { path: CONTROL_ROUTES.hostHeartbeat, method: 'POST', body: '{}', at: 2000 },
    ])
    expect(state.calls[0]?.headers.get('a')).toBe('b')
  })
})

describe('controlTransport mode selection', () => {
  async function statusFor(mode: ControlMode, path: string, init = other) {
    const { state, fetch } = transport()
    state.mode = mode
    return (await fetch(url(path), init)).status
  }

  it('answers each mode by route', async () => {
    expect(await statusFor('ok', CONTROL_ROUTES.hostSelf)).toBe(200)
    expect(await statusFor('gone', CONTROL_ROUTES.hostSelf)).toBe(410)
    expect(await statusFor('gone', CONTROL_ROUTES.hostRevoke)).toBe(410)
    expect(await statusFor('gone', CONTROL_ROUTES.enrollments)).toBe(200)
    expect(await statusFor('unavailable', CONTROL_ROUTES.enrollments)).toBe(503)
    await expect(statusFor('offline', CONTROL_ROUTES.health)).rejects.toThrow()
  })

  it('chooses finalMode for the enrolled host header and mode for every other request', async () => {
    const { state, fetch } = transport()
    state.mode = 'unavailable'
    state.finalMode = 'gone'
    expect((await fetch(url(CONTROL_ROUTES.hostSelf), enrolled)).status).toBe(410)
    expect((await fetch(url(CONTROL_ROUTES.hostSelf), other)).status).toBe(503)
    expect((await fetch(url(CONTROL_ROUTES.hostSelf))).status).toBe(503)
  })
})

describe('controlTransport routes', () => {
  it('answers enrollment creation for the sent key, with the creation override last', async () => {
    const { state, fetch } = transport(10_000)
    const key = Buffer.from([1, 2, 3])
    state.creation = { pollIntervalSec: 1, enrollmentId: 'other' }
    const response = await fetch(url(CONTROL_ROUTES.enrollments), {
      headers: { [HOST_HEADERS.key]: key.toString('base64url') },
    })
    expect(await response.json()).toEqual({
      enrollmentId: 'other',
      userCode: 'BCDFGHJK',
      keyFingerprint: formatKeyFingerprint(createHash('sha256').update(key).digest()),
      expiresAt: new Date(10_000 + 600_000).toISOString(),
      pollIntervalSec: 1,
    })
  })

  it('counts polls and returns the answer current at each poll', async () => {
    const { state, fetch } = transport()
    state.answer = { status: 'pending' }
    expect(await (await fetch(url(CONTROL_ROUTES.enrollmentPoll))).json()).toEqual({
      status: 'pending',
    })
    state.answer = { status: 'denied' }
    expect(await (await fetch(url(CONTROL_ROUTES.enrollmentPoll))).json()).toEqual({
      status: 'denied',
    })
    expect(state.polls).toBe(2)
  })

  it('revokes with an empty 204 and otherwise echoes the sent host in the server view', async () => {
    const { fetch } = transport()
    const revoke = await fetch(url(CONTROL_ROUTES.hostRevoke))
    expect([revoke.status, await revoke.text()]).toEqual([204, ''])
    expect(await (await fetch(url(CONTROL_ROUTES.machines), other)).json()).toEqual({
      ...serverView,
      hostId: 'someone-else',
    })
  })
})
