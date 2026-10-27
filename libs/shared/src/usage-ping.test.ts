import { describe, expect, it, vi } from 'vitest'
import { CONTROL_ROUTES, parseUsagePing } from './control-api'
import {
  isoWeek,
  parseUsagePingMarks,
  planUsagePing,
  sendUsagePing,
  usageMarks,
  usagePingOptedOut,
} from './usage-ping'

const base = { product: 'desktop', version: '0.1.600', platform: 'darwin', arch: 'arm64' } as const
const at = (iso: string) => new Date(iso)

describe('isoWeek', () => {
  it.each([
    ['2026-01-01T12:00:00Z', '2026-W01'], // Thursday
    ['2027-01-01T00:00:00Z', '2026-W53'], // Friday, still the previous ISO year
    ['2024-12-30T00:00:00Z', '2025-W01'], // Monday, already the next ISO year
    ['2026-10-26T00:00:00Z', '2026-W44'], // Monday
    ['2026-11-01T23:59:59Z', '2026-W44'], // Sunday
  ])('%s is %s', (iso, week) => expect(isoWeek(at(iso))).toBe(week))

  it('uses UTC, not the local zone', () => {
    expect(usageMarks(at('2026-10-31T23:30:00-05:00'))).toEqual({
      day: '2026-11-01',
      week: '2026-W44',
      month: '2026-11',
    })
  })
})

describe('planUsagePing', () => {
  it('marks a first ping new for its week and month, and the server accepts it', () => {
    const plan = planUsagePing({ ...base, marks: null, now: at('2026-10-27T10:00:00Z') })
    expect(plan?.ping).toEqual({
      v: 1,
      product: 'desktop',
      version: '0.1.600',
      os: 'darwin',
      arch: 'arm64',
      first: true,
      newWeek: true,
      newMonth: true,
    })
    expect(parseUsagePing(plan?.ping).ok).toBe(true)
    expect(plan?.marks).toEqual({ day: '2026-10-27', week: '2026-W44', month: '2026-10' })
  })

  it('derives the flags from the last marks', () => {
    const marks = usageMarks(at('2026-10-27T10:00:00Z'))
    const sameWeek = planUsagePing({ ...base, marks, now: at('2026-10-28T01:00:00Z') })
    expect(sameWeek?.ping).toMatchObject({ first: false, newWeek: false, newMonth: false })
    const nextMonth = planUsagePing({ ...base, marks, now: at('2026-11-01T01:00:00Z') })
    expect(nextMonth?.ping).toMatchObject({ first: false, newWeek: false, newMonth: true })
    const midMonth = usageMarks(at('2026-10-14T10:00:00Z'))
    const nextWeek = planUsagePing({ ...base, marks: midMonth, now: at('2026-10-20T01:00:00Z') })
    expect(nextWeek?.ping).toMatchObject({ first: false, newWeek: true, newMonth: false })
  })

  it('sends nothing twice a day, or after the clock moved back', () => {
    const marks = usageMarks(at('2026-10-27T10:00:00Z'))
    expect(planUsagePing({ ...base, marks, now: at('2026-10-27T23:59:00Z') })).toBeNull()
    expect(planUsagePing({ ...base, marks, now: at('2026-10-20T10:00:00Z') })).toBeNull()
  })

  it.each([
    { version: '0.1.600-beta.1' },
    { version: '0.0.0-dev' },
    { platform: 'freebsd' },
    { arch: 'ia32' },
  ])('sends nothing for %o', (patch) => {
    expect(planUsagePing({ ...base, ...patch, marks: null, now: new Date() })).toBeNull()
  })
})

it('reads back only well-formed marks', () => {
  const marks = { day: '2026-10-27', week: '2026-W44', month: '2026-10' }
  expect(parseUsagePingMarks(marks)).toEqual(marks)
  expect(parseUsagePingMarks({ ...marks, id: 'x' })).toEqual(marks)
  expect(parseUsagePingMarks({ ...marks, week: '44' })).toBeNull()
  expect(parseUsagePingMarks('2026-10-27')).toBeNull()
  expect(parseUsagePingMarks(null)).toBeNull()
})

it.each([
  [{}, false],
  [{ DO_NOT_TRACK: '0' }, false],
  [{ DO_NOT_TRACK: '' }, false],
  [{ DO_NOT_TRACK: '1' }, true],
  [{ DO_NOT_TRACK: 'true' }, true],
  [{ PHOSPHOR_NO_USAGE_PING: '1' }, true],
])('opt-out env %o is %s', (env, out) => expect(usagePingOptedOut(env)).toBe(out))

describe('sendUsagePing', () => {
  const ping = planUsagePing({ ...base, marks: null, now: new Date() })!.ping

  it('posts only the ping, with no credentials or identifying header', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }))
    expect(await sendUsagePing(ping, { baseUrl: 'https://control.test', fetch })).toBe(true)
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.href).toBe(`https://control.test${CONTROL_ROUTES.usagePing}`)
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' })
    expect(init.headers).toEqual({ 'content-type': 'application/json' })
    expect(JSON.parse(init.body as string)).toEqual(ping)
  })

  it('is false on any other status or a network failure', async () => {
    const reply = (status: number) => async () => new Response('{}', { status })
    for (const fetch of [reply(503), reply(400), reply(200)])
      expect(await sendUsagePing(ping, { baseUrl: 'https://c.test', fetch })).toBe(false)
    const fetch = async () => Promise.reject(new TypeError('fetch failed'))
    expect(await sendUsagePing(ping, { baseUrl: 'https://c.test', fetch })).toBe(false)
  })
})
