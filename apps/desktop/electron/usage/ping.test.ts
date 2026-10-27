import { describe, expect, it, vi } from 'vitest'
import { CONTROL_ROUTES, DEFAULT_CONTROL_URL } from '@shared/control-api'
import { createUsagePing, FIRST_PING_DELAY_MS, PING_RECHECK_MS, type UsagePingPorts } from './ping'

function harness(overrides: Partial<UsagePingPorts> & { stored?: unknown } = {}) {
  let stored: unknown = overrides.stored
  let now = new Date('2026-10-27T10:00:00Z')
  const fetch = vi.fn(async () => new Response(null, { status: 204 }))
  const timers: Array<{ kind: string; ms: number; run: () => void }> = []
  const schedule = (kind: string) => (run: () => void, ms: number) => {
    timers.push({ kind, ms, run })
    return { unref: () => undefined }
  }
  const service = createUsagePing({
    packaged: true,
    env: {},
    version: '0.1.600',
    platform: 'linux',
    arch: 'x64',
    load: () => stored,
    save: (record) => {
      stored = record
    },
    fetch,
    now: () => now,
    random: () => 0.5,
    setTimeout: schedule('timeout'),
    setInterval: schedule('interval'),
    ...overrides,
  })
  const sent = () =>
    (fetch.mock.calls as unknown as Array<[URL, RequestInit]>).map(([url, init]) => ({
      url: url.href,
      body: JSON.parse(init.body as string) as Record<string, unknown>,
    }))
  return {
    service,
    fetch,
    timers,
    sent,
    stored: () => stored,
    setNow: (iso: string) => (now = new Date(iso)),
  }
}

describe('Desktop usage ping', () => {
  it('sends nothing, and sets no timer, from a dev build or with DO_NOT_TRACK', async () => {
    for (const ports of [{ packaged: false }, { env: { DO_NOT_TRACK: '1' } }]) {
      const h = harness({ ...ports, stored: { noticeShown: true } })
      h.service.start()
      await h.service.tick()
      expect(h.timers).toEqual([])
      expect(h.fetch).not.toHaveBeenCalled()
    }
    expect(harness({ packaged: false }).service.settings().blocked).toBe('dev-build')
    expect(harness({ env: { DO_NOT_TRACK: '1' } }).service.settings().blocked).toBe('environment')
  })

  it('waits for the notice, and stops when switched off', async () => {
    const h = harness()
    await h.service.tick()
    expect(h.fetch).not.toHaveBeenCalled()
    h.service.set({ noticeShown: true, enabled: false })
    await h.service.tick()
    expect(h.fetch).not.toHaveBeenCalled()
    expect(h.service.settings()).toMatchObject({ enabled: false, noticeShown: true })
  })

  it('sends one first ping a day to the control plane and keeps the marks', async () => {
    const h = harness({ stored: { noticeShown: true } })
    await h.service.tick()
    await h.service.tick()
    expect(h.sent()).toEqual([
      {
        url: `${DEFAULT_CONTROL_URL}${CONTROL_ROUTES.usagePing}`,
        body: {
          v: 1,
          product: 'desktop',
          version: '0.1.600',
          os: 'linux',
          arch: 'x64',
          first: true,
          newWeek: true,
          newMonth: true,
        },
      },
    ])
    expect(h.stored()).toEqual({
      enabled: true,
      noticeShown: true,
      marks: { day: '2026-10-27', week: '2026-W44', month: '2026-10' },
    })
    h.setNow('2026-10-28T09:00:00Z')
    await h.service.tick()
    expect(h.sent()[1]?.body).toMatchObject({ first: false, newWeek: false, newMonth: false })
  })

  it('keeps the old marks when a ping is not counted, so it is retried', async () => {
    const h = harness({ stored: { noticeShown: true } })
    h.fetch.mockResolvedValueOnce(new Response('{}', { status: 503 }))
    await h.service.tick()
    expect(h.stored()).toEqual({ noticeShown: true })
    await h.service.tick()
    expect(h.sent().map((ping) => ping.body.first)).toEqual([true, true])
  })

  it('previews the next ping: today until sent, then tomorrow', async () => {
    const h = harness({ stored: { noticeShown: true } })
    expect(h.service.settings().preview).toMatchObject({ first: true })
    await h.service.tick()
    expect(h.service.settings().preview).toMatchObject({ first: false, newWeek: false })
  })

  it('reads a damaged record as defaults: on, notice not yet shown', () => {
    for (const stored of [undefined, 'x', { enabled: 'no', noticeShown: 1, marks: 'today' }])
      expect(harness({ stored }).service.settings()).toMatchObject({
        enabled: true,
        noticeShown: false,
      })
  })

  it('schedules once: a delayed first try, then a recheck', async () => {
    const h = harness({ stored: { noticeShown: true } })
    h.service.start()
    h.service.start()
    const { min, max } = FIRST_PING_DELAY_MS
    expect(h.timers.map(({ kind, ms }) => [kind, ms])).toEqual([
      ['timeout', min + (max - min) / 2],
      ['interval', PING_RECHECK_MS],
    ])
    h.timers[0]?.run()
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1))
  })
})
