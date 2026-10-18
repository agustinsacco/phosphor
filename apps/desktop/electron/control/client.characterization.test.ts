import { describe, expect, it, vi } from 'vitest'
import { CONTROL_ROUTES, DEFAULT_CONTROL_URL } from '@shared/control-api'
import { createControlClient } from './client'
import { LOOKUP, MACHINE } from '../../src/features/machines/__fixtures__/control'

const me = { account: { login: 'octo' }, enabled: true, maxHosts: 20 }
const machines = { machines: [], serverTime: '2026-01-01T00:00:00.000Z' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
function harness() {
  let token = 'request-local-token'
  let generation = 0
  const log = vi.fn()
  const fetchImpl = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith('/me') ? json(me) : json(machines),
  )
  const client = createControlClient({
    baseUrl: () => DEFAULT_CONTROL_URL,
    accessToken: async () => token,
    generation: () => generation,
    now: () => Date.parse(LOOKUP.expiresAt) - 1000,
    fetch: fetchImpl,
    log,
  })
  return {
    client,
    fetchImpl,
    log,
    refresh: () => {
      token = 'refreshed-request-token'
    },
    changeAccount: () => {
      generation++
    },
    paths: () => fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname),
  }
}

describe('control client public boundary characterization', () => {
  it('accepts exactly 64 KiB streamed bytes and cancels one byte over', async () => {
    for (const size of [64 * 1024, 64 * 1024 + 1]) {
      const h = harness()
      await h.client.machines()
      const cancel = vi.fn()
      h.fetchImpl.mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              const raw = JSON.stringify(machines).padEnd(size, ' ')
              controller.enqueue(new TextEncoder().encode(raw.slice(0, 1024)))
              controller.enqueue(new TextEncoder().encode(raw.slice(1024)))
              if (size === 64 * 1024) controller.close()
            },
            cancel,
          }),
        ),
      )
      const result = await h.client.machines()
      expect(result).toEqual(
        size === 64 * 1024
          ? { ok: true, ...machines }
          : {
              ok: false,
              error: { code: 'internal', message: 'The control request could not complete.' },
            },
      )
      expect(cancel).toHaveBeenCalledTimes(size === 64 * 1024 ? 0 : 1)
    }
  })

  it('clears account admission on 401 and cancels without retrying', async () => {
    const h = harness()
    await h.client.machines()
    const cancel = vi.fn()
    h.fetchImpl.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 401 }))
    expect(await h.client.machines()).toMatchObject({ error: { code: 'signed-out' } })
    expect(cancel).toHaveBeenCalledOnce()
    expect(h.fetchImpl).toHaveBeenCalledTimes(3)
    await h.client.machines()
    expect(h.paths()).toEqual([
      CONTROL_ROUTES.me,
      CONTROL_ROUTES.machines,
      CONTROL_ROUTES.machines,
      CONTROL_ROUTES.me,
      CONTROL_ROUTES.machines,
    ])
  })

  it('requires DELETE 204 with zero bytes, not a JSON null body or empty 200', async () => {
    const h = harness()
    await h.client.machines()
    h.fetchImpl.mockResolvedValueOnce(new Response(null, { status: 204 }))
    expect(await h.client.removeMachine(MACHINE.id)).toEqual({ ok: true })
    const nonempty = new Response(null, { status: 204 })
    Object.defineProperty(nonempty, 'body', {
      value: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('null'))
          controller.close()
        },
      }),
    })
    for (const response of [nonempty, new Response(null), json({})]) {
      h.fetchImpl.mockResolvedValueOnce(response)
      expect(await h.client.removeMachine(MACHINE.id)).toMatchObject({
        error: { code: 'internal' },
      })
    }
  })

  it('reasks me after a token refresh without changing account generation', async () => {
    const h = harness()
    h.fetchImpl.mockResolvedValueOnce(json({ ...me, enabled: false }))
    expect(await h.client.machines()).toMatchObject({ error: { code: 'forbidden' } })
    expect(await h.client.machines()).toMatchObject({ error: { code: 'forbidden' } })
    expect(h.paths()).toEqual([CONTROL_ROUTES.me])
    h.refresh()
    expect(await h.client.machines()).toEqual({ ok: true, ...machines })
    expect(h.paths()).toEqual([CONTROL_ROUTES.me, CONTROL_ROUTES.me, CONTROL_ROUTES.machines])
  })

  it('discards account and operation replies after generation changes', async () => {
    const account = harness()
    account.fetchImpl.mockImplementationOnce(async () => {
      account.changeAccount()
      return json(me)
    })
    expect(await account.client.machines()).toMatchObject({ error: { code: 'signed-out' } })
    expect(account.paths()).toEqual([CONTROL_ROUTES.me])
    const operation = harness()
    await operation.client.machines()
    operation.fetchImpl.mockImplementationOnce(async () => {
      operation.changeAccount()
      return json(machines)
    })
    expect(await operation.client.machines()).toMatchObject({ error: { code: 'signed-out' } })
  })

  it('never echoes peer error text in results or observation logs', async () => {
    const h = harness()
    await h.client.machines()
    h.fetchImpl.mockResolvedValueOnce(
      json({ error: { code: 'conflict', message: 'peer-secret' } }, 409),
    )
    const result = await h.client.lookupEnrollment('BCDF-GHJK')
    expect(result).toEqual({
      ok: false,
      error: { code: 'conflict', message: 'The control request could not complete.' },
    })
    const text = JSON.stringify([result, h.log.mock.calls])
    for (const secret of ['peer-secret', 'request-local-token', 'BCDF-GHJK', 'BCDFGHJK'])
      expect(text).not.toContain(secret)
  })

  it('links enrollment lookup and approval traces once and keeps subsequent calls independent', async () => {
    const h = harness()
    h.fetchImpl.mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname
      return json(
        path === CONTROL_ROUTES.me
          ? me
          : path === CONTROL_ROUTES.enrollmentLookup
            ? LOOKUP
            : { machine: MACHINE },
      )
    })
    await h.client.lookupEnrollment('BCDF-GHJK')
    await h.client.approveEnrollment('BCDF-GHJK', 'bee1')
    await h.client.approveEnrollment('BCDF-GHJK', 'bee1')
    const calls = h.log.mock.calls.filter(([, name]) => name === 'call').map(([, , data]) => data)
    expect(calls.map(({ route }) => route)).toEqual([
      CONTROL_ROUTES.me,
      CONTROL_ROUTES.enrollmentLookup,
      CONTROL_ROUTES.enrollmentApprove,
      CONTROL_ROUTES.enrollmentApprove,
    ])
    expect(calls[0].trace).toMatch(/^[0-9a-f]{16}$/)
    expect(calls[0].trace).toBe(calls[1].trace)
    expect(calls[1].trace).toBe(calls[2].trace)
    expect(calls[3].trace).not.toBe(calls[2].trace)
  })
})
