import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserControl } from './control'
import { WEB_CSRF_HEADER, WEB_AUTH_ROUTES } from '@phosphor/shared/web-auth'

const user = '11111111-1111-4111-8111-111111111111'
const clientId = '22222222-2222-4222-8222-222222222222'
const session = { user: { id: user, login: 'fixture' }, clientId, csrfToken: 'a'.repeat(43) }
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
const disposals: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose()
  vi.useRealTimers()
})
function setup(fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>) {
  const changed = vi.fn(),
    invalidate = vi.fn(),
    navigate = vi.fn()
  const control = createBrowserControl({ fetch, changed, invalidate, navigate })
  disposals.push(control.dispose)
  return { control, changed, invalidate, navigate }
}

describe('browser cookie control', () => {
  it('hydrates only public profile and sends session-bound CSRF with cookie writes', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (path) =>
      path === WEB_AUTH_ROUTES.session
        ? json({ ...session, access_token: 'must-not-escape' })
        : json({ signedOut: true, remoteCleanup: 'complete' }),
    )
    const { control } = setup(fetch)
    await control.refresh()
    expect(control.view()).toMatchObject({
      account: { status: 'signed-in', user: { login: 'fixture', email: null } },
    })
    expect(JSON.stringify(control.view())).not.toContain('must-not-escape')
    expect(await control.signOut()).toEqual({ account: { status: 'signed-out' } })
    const options = fetch.mock.calls[1]?.[1]
    expect(options).toMatchObject({
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      method: 'POST',
      body: '{}',
    })
    expect(options?.headers).toMatchObject({ [WEB_CSRF_HEADER]: session.csrfToken })
    expect(options?.headers).not.toHaveProperty('Authorization')
    expect(control.session()).toBeNull()
  })
  it.each([401, 403])('drops current authority even for a non-JSON HTTP %s', async (status) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(new Response('denied', { status }))
    const { control, invalidate } = setup(fetch)
    await control.refresh()
    const before = invalidate.mock.calls.length
    const result = await control.machines()
    expect(result.ok).toBe(false)
    expect(control.session()).toBeNull()
    expect(invalidate.mock.calls.length).toBeGreaterThan(before)
  })
  it('does not confuse service outage with cookie expiry', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(json({ error: { code: 'unavailable', message: 'Unavailable' } }, 503))
    const { control } = setup(fetch)
    await control.refresh()
    await expect(control.refresh()).rejects.toThrow('unavailable')
    expect(control.view().account.status).toBe('signed-in')
  })
  it.each(['pending', 'offline'])(
    'reports %s signout without promising revocation or restoring access',
    async (mode) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(session))
      if (mode === 'pending')
        fetch.mockResolvedValueOnce(json({ signedOut: true, remoteCleanup: 'pending' }))
      else fetch.mockRejectedValueOnce(new TypeError('Network failed'))
      const { control } = setup(fetch)
      await control.refresh()
      expect(await control.signOut()).toMatchObject({
        account: { status: 'signed-out', error: expect.stringMatching(/pending|not confirmed/) },
      })
      await control.refresh()
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(await control.machines()).toMatchObject({ ok: false, error: { code: 'signed-out' } })
    },
  )
  it('fences a late session after logout and a late directory after owner invalidation', async () => {
    let deliver!: (response: Response) => void
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deliver = resolve
        }),
    )
    const { control } = setup(fetch)
    const pending = control.refresh()
    control.invalidate()
    deliver(json(session))
    await pending
    expect(control.session()).toBeNull()
    control.signIn()
    fetch.mockResolvedValueOnce(json(session))
    await control.refresh()
    fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deliver = resolve
        }),
    )
    const directory = control.machines()
    control.invalidate()
    deliver(json({ machines: [], serverTime: new Date().toISOString() }))
    expect(await directory).toMatchObject({ ok: false, error: { code: 'signed-out' } })
  })
  it('drops memory for same-user client or CSRF changes, not only a different user id', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(json({ ...session, csrfToken: 'b'.repeat(43) }))
    const { control, invalidate } = setup(fetch)
    await control.refresh()
    const before = invalidate.mock.calls.length
    await control.refresh()
    expect(invalidate.mock.calls.length).toBe(before + 1)
  })
  it('bounds responses, validates session fields and aborts requests on deadline', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ ...session, clientId: 'invalid' }))
      .mockResolvedValueOnce(json({ junk: 'x'.repeat(140_000) }))
    const { control } = setup(fetch)
    await expect(control.refresh()).rejects.toThrow('unavailable')
    await expect(control.refresh()).rejects.toThrow('unavailable')
    vi.useFakeTimers()
    fetch.mockImplementationOnce(
      (_path, options) =>
        new Promise((_resolve, reject) =>
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    )
    const pending = expect(control.refresh()).rejects.toThrow('offline')
    await vi.advanceTimersByTimeAsync(10_000)
    await pending
  })
  it('uses only a fixed same-origin login URL and accepts a successful DELETE 204', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    const { control, navigate } = setup(fetch)
    control.signIn()
    expect(navigate).toHaveBeenCalledWith('/api/auth/start')
    await control.refresh()
    expect(await control.remove(user)).toEqual({ ok: true })
  })
})

it('refuses oversized control writes before fetch', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(session))
  const { control } = setup(fetch)
  await control.refresh()
  expect(await control.approve('BCDFGHJK', 'x'.repeat(20_000))).toMatchObject({
    ok: false,
    error: { code: 'bad-request' },
  })
  expect(fetch).toHaveBeenCalledOnce()
})

it.each(['pending', 'offline'] as const)(
  'preserves unconfirmed cleanup after %s logout followed by retry/401',
  async (outcome) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(session))
    if (outcome === 'pending')
      fetch.mockResolvedValueOnce(json({ signedOut: true, remoteCleanup: 'pending' }))
    else fetch.mockRejectedValueOnce(new TypeError('offline'))
    fetch.mockResolvedValueOnce(json({}, 401))
    const { control } = setup(fetch)
    await control.refresh()
    await control.signOut()
    const view = await control.signOut()
    expect(view).toMatchObject({
      account: {
        status: 'signed-out',
        error: expect.stringMatching(/cleanup.*(pending|not confirmed)|revocation.*not confirmed/i),
      },
    })
    expect(control.session()).toBeNull()
  },
)

it('cannot publish a late successful logout into a new owner generation', async () => {
  let release!: (response: Response) => void
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(json(session))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    .mockResolvedValueOnce(json({ ...session, user: { id: clientId, login: 'other-fixture' } }))
  const { control } = setup(fetch)
  await control.refresh()
  const logout = control.signOut()
  control.signIn()
  await control.refresh()
  release(json({ signedOut: true, remoteCleanup: 'complete' }))
  await logout
  expect(control.view()).toMatchObject({
    account: { status: 'signed-in', user: { login: 'other-fixture' } },
  })
})

it('removes the cleanup warning only after a server-confirmed complete retry', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(json(session))
    .mockResolvedValueOnce(json({ signedOut: true, remoteCleanup: 'pending' }))
    .mockResolvedValueOnce(json(session))
    .mockResolvedValueOnce(json({ signedOut: true, remoteCleanup: 'complete' }))
  const { control } = setup(fetch)
  await control.refresh()
  await control.signOut()
  expect(await control.signOut()).toEqual({ account: { status: 'signed-out' } })
  expect(await control.signOut()).toEqual({ account: { status: 'signed-out' } })
  expect(fetch).toHaveBeenCalledTimes(4)
})

it.each([
  ['account-disabled', () => json({ error: { code: 'forbidden', message: 'Disabled' } }, 403)],
  ['grant-refused', () => json({ error: { code: 'not-found', message: 'Refused' } }, 404)],
  ['grant-refused', () => json({ error: { code: 'gone', message: 'Gone' } }, 410)],
  ['unavailable', () => json({ error: { code: 'unavailable', message: 'Down' } }, 503)],
  ['offline', () => Promise.reject(new TypeError('Network failed'))],
] as const)('reports only the sanitized grant refusal %s', async (code, reply) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (path) =>
    path === WEB_AUTH_ROUTES.session ? json(session) : reply(),
  )
  const { control } = setup(fetch)
  await control.refresh()
  const host = '33333333-3333-4333-8333-333333333333'
  await expect(control.grant(host)).rejects.toThrow(new Error(code))
})

describe('browser configuration grant opt-in', () => {
  const host = '33333333-3333-4333-8333-333333333333'
  const other = '44444444-4444-4444-8444-444444444444'
  function grants(fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>) {
    return fetch.mock.calls
      .filter(([path]) => path === '/api/v1/grants')
      .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)
  }
  function grantFetch(sessionStatus: () => number = () => 200) {
    return vi.fn<typeof globalThis.fetch>(async (path) =>
      path === WEB_AUTH_ROUTES.session
        ? json(sessionStatus() === 200 ? session : {}, sessionStatus())
        : path === '/api/v1/grants'
          ? json({ error: { code: 'unavailable', message: 'Unavailable' } }, 503)
          : json({}, 401),
    )
  }
  it('asks for configure only for the Host the page opted in, and stops when opted out', async () => {
    const fetch = grantFetch()
    const { control } = setup(fetch)
    await control.refresh()
    await control.grant(host).catch(() => {})
    control.configure(host)
    await control.grant(host).catch(() => {})
    await control.grant(other).catch(() => {})
    control.configure(host, false)
    await control.grant(host).catch(() => {})
    expect(grants(fetch)).toEqual([
      { hostId: host, clientId },
      { hostId: host, clientId, configure: true },
      { hostId: other, clientId },
      { hostId: host, clientId },
    ])
  })
  it('refuses to opt in while signed out or disposed', async () => {
    const { control } = setup(grantFetch())
    expect(() => control.configure(host)).toThrow('signed-out')
    await control.refresh()
    control.dispose()
    expect(() => control.configure(host)).toThrow('signed-out')
  })
  it('forgets the opt-in when Control refuses the cookie', async () => {
    let status = 200
    const fetch = grantFetch(() => status)
    const { control } = setup(fetch)
    await control.refresh()
    control.configure(host)
    status = 401
    await control.refresh()
    status = 200
    control.signIn()
    await control.refresh()
    await control.grant(host).catch(() => {})
    expect(grants(fetch)).toEqual([{ hostId: host, clientId }])
  })
})
