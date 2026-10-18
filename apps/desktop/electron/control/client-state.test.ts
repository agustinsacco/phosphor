import { describe, expect, it, vi } from 'vitest'
import { CONTROL_ROUTES, DEFAULT_CONTROL_URL, parseMachinesResponse } from '@shared/control-api'
import { createControlState } from './client-state'

const me = { account: { login: 'octo' }, enabled: true, maxHosts: 20 }
const machines = { machines: [], serverTime: '2026-01-01T00:00:00.000Z' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
function harness() {
  let token: string | null = 'first-token'
  let generation = 0
  const clearObservations = vi.fn()
  const fetchImpl = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith('/me') ? json(me) : json(machines),
  )
  const accessToken = vi.fn(async () => token)
  const log = vi.fn()
  const state = createControlState({
    baseUrl: () => DEFAULT_CONTROL_URL,
    accessToken,
    generation: () => generation,
    clearObservations,
    log,
    now: () => 0,
    fetch: fetchImpl,
  })
  return {
    state,
    fetchImpl,
    accessToken,
    log,
    clearObservations,
    list: () => state.call(CONTROL_ROUTES.machines, 'GET', parseMachinesResponse),
    setToken: (value: string | null) => {
      token = value
    },
    changeAccount: () => {
      generation++
    },
    paths: () => fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname),
  }
}

describe('createControlState', () => {
  it('single-flights account admission while keeping tokens request-local', async () => {
    const h = harness()
    await Promise.all([h.list(), h.list(), h.list()])
    expect(h.paths()).toEqual([CONTROL_ROUTES.me, ...Array(3).fill(CONTROL_ROUTES.machines)])
    expect(h.accessToken).toHaveBeenCalledTimes(3)
    expect(
      h.fetchImpl.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization')),
    ).toEqual(Array(4).fill('Bearer first-token'))
    // ClientState keeps only a sha256 digest of the token (private); the log is the observable leak.
    expect(JSON.stringify(h.log.mock.calls)).not.toContain('first-token')
  })

  it('keys cached account admission by both token digest and generation', async () => {
    const h = harness()
    await h.list()
    h.setToken('refreshed-token')
    await h.list()
    h.changeAccount()
    await h.list()
    expect(h.paths()).toEqual(Array(3).fill([CONTROL_ROUTES.me, CONTROL_ROUTES.machines]).flat())
    expect(h.clearObservations).toHaveBeenCalledOnce()
    expect(JSON.stringify([h.state, h.log.mock.calls])).not.toContain('refreshed-token')
  })

  it('retains disabled admission until refresh but evicts failed admission', async () => {
    const h = harness()
    h.fetchImpl.mockResolvedValueOnce(json({ ...me, enabled: false }))
    expect(await h.list()).toMatchObject({ error: { code: 'forbidden' } })
    expect(await h.list()).toMatchObject({ error: { code: 'forbidden' } })
    expect(h.paths()).toEqual([CONTROL_ROUTES.me])
    h.setToken('refresh')
    h.fetchImpl.mockResolvedValueOnce(json({}))
    expect(await h.list()).toMatchObject({ error: { code: 'internal' } })
    expect(await h.list()).toEqual({ ok: true, ...machines })
    expect(h.paths()).toEqual([
      CONTROL_ROUTES.me,
      CONTROL_ROUTES.me,
      CONTROL_ROUTES.me,
      CONTROL_ROUTES.machines,
    ])
  })

  it('drops a missing token and a token acquired across a generation change', async () => {
    const h = harness()
    h.setToken(null)
    expect(await h.list()).toMatchObject({ error: { code: 'signed-out' } })
    h.accessToken.mockImplementationOnce(async () => {
      h.changeAccount()
      return 'old-account-token'
    })
    expect(await h.list()).toMatchObject({ error: { code: 'signed-out' } })
    expect(h.fetchImpl).not.toHaveBeenCalled()
    expect(h.clearObservations).toHaveBeenCalledTimes(2)
  })

  it('rejects late account and endpoint responses after account changes', async () => {
    for (const path of [CONTROL_ROUTES.me, CONTROL_ROUTES.machines]) {
      const h = harness()
      h.fetchImpl.mockImplementation(async (url) => {
        const account = String(url).endsWith('/me')
        if (new URL(String(url)).pathname === path) h.changeAccount()
        return json(account ? me : machines)
      })
      expect(await h.list()).toMatchObject({ error: { code: 'signed-out' } })
      expect(h.fetchImpl).toHaveBeenCalledTimes(path === CONTROL_ROUTES.me ? 1 : 2)
    }
  })

  it('does not let an older failed admission evict the refreshed single flight', async () => {
    const h = harness()
    let resolveOld: (response: Response) => void = () => {
      throw new Error('not started')
    }
    h.fetchImpl.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveOld = resolve
        }),
    )
    const old = h.list()
    await vi.waitFor(() => expect(h.fetchImpl).toHaveBeenCalledOnce())
    h.setToken('refresh')
    expect(await h.list()).toEqual({ ok: true, ...machines })
    resolveOld(json({}))
    expect(await old).toMatchObject({ error: { code: 'internal' } })
    await h.list()
    expect(h.paths()).toEqual([
      CONTROL_ROUTES.me,
      CONTROL_ROUTES.me,
      CONTROL_ROUTES.machines,
      CONTROL_ROUTES.machines,
    ])
  })

  it('invalidates admission on endpoint 401 before cancellation completes', async () => {
    const h = harness()
    await h.list()
    const cancel = vi.fn(() => {
      expect(h.clearObservations).toHaveBeenCalledOnce()
    })
    h.fetchImpl.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 401 }))
    expect(await h.list()).toMatchObject({ error: { code: 'signed-out' } })
    await h.list()
    expect(cancel).toHaveBeenCalledOnce()
    expect(h.paths().filter((path) => path === CONTROL_ROUTES.me)).toHaveLength(2)
  })

  it('clears generation-scoped observations once even without a network call', () => {
    const h = harness()
    h.state.syncGeneration()
    expect(h.clearObservations).not.toHaveBeenCalled()
    h.changeAccount()
    h.state.syncGeneration()
    h.state.syncGeneration()
    expect(h.clearObservations).toHaveBeenCalledOnce()
  })

  it('maps token acquisition failures to a fixed offline error', async () => {
    const h = harness()
    h.accessToken.mockRejectedValueOnce(new Error('secret'))
    expect(await h.list()).toEqual({
      ok: false,
      error: { code: 'offline', message: 'The control request could not complete.' },
    })
    expect(h.fetchImpl).not.toHaveBeenCalled()
  })
})
