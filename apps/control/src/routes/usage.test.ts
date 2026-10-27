import { describe, expect, it, vi } from 'vitest'
import { CONTROL_ROUTES as R, DOWNLOAD_ARTIFACTS } from '@phosphor/shared/control-api'
import { token } from '../test-support'
import { fixture, origin } from '../web/test-fixture'
import { setup } from './__fixtures__/fixtures'
import { DOWNLOAD_TARGETS, USAGE_LIMITS } from './usage'

const ping = {
  v: 1,
  product: 'desktop',
  version: '0.1.542',
  os: 'darwin',
  arch: 'arm64',
  first: true,
  newWeek: true,
  newMonth: false,
}
const peer = (remoteAddress: string) => ({ incoming: { headers: {}, socket: { remoteAddress } } })
function send(
  app: ReturnType<typeof setup>['app'],
  value: unknown,
  extra = {},
  address = '203.0.113.5',
) {
  return app.request(
    R.usagePing,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...extra },
      body: JSON.stringify(value),
    },
    peer(address),
  )
}
const rpcCalls = (deps: ReturnType<typeof setup>['deps'], name: string) =>
  vi.mocked(deps.supabase.rpc).mock.calls.filter(([called]) => called === name)

describe('usage ping', () => {
  it('counts the exact payload and answers 204 with no body', async () => {
    const f = setup()
    f.results.control_usage_ping = { outcome: 'counted' }
    const res = await send(f.app, ping)
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(rpcCalls(f.deps, 'control_usage_ping')).toEqual([
      [
        'control_usage_ping',
        {
          p_product: 'desktop',
          p_version: '0.1.542',
          p_os: 'darwin',
          p_arch: 'arm64',
          p_first: true,
          p_new_week: true,
          p_new_month: false,
        },
      ],
    ])
  })

  it('refuses extra fields, browsers and anything carrying an account', async () => {
    const f = setup()
    expect((await send(f.app, { ...ping, installId: 'x' })).status).toBe(400)
    expect((await send(f.app, { ...ping, version: '0.1.542-dev' })).status).toBe(400)
    expect((await send(f.app, ping, { origin: 'https://evil.example' })).status).toBe(403)
    const bearer = `Bearer ${token(Math.floor(f.deps.clock() / 1000) + 100)}`
    expect((await send(f.app, ping, { authorization: bearer })).status).toBe(400)
    expect(f.deps.supabase.getUser).not.toHaveBeenCalled()
    expect(rpcCalls(f.deps, 'control_usage_ping')).toEqual([])
  })

  it('is not served on the app origin', async () => {
    const f = fixture()
    const res = await f.app.request(origin + R.usagePing, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ping),
    })
    expect(res.status).toBe(404)
    expect(rpcCalls(f.deps as never, 'control_usage_ping')).toEqual([])
  })

  it('stops counting one address past its daily limit, without telling it', async () => {
    const f = setup()
    f.results.control_usage_ping = { outcome: 'counted' }
    const consume = vi.spyOn(f.deps.limits, 'consume')
    const limit = USAGE_LIMITS.pingsPerAddressPerDay
    for (let i = 0; i <= limit; i++) expect((await send(f.app, ping)).status).toBe(204)
    expect(rpcCalls(f.deps, 'control_usage_ping')).toHaveLength(limit)
    expect((await send(f.app, ping, {}, '198.51.100.7')).status).toBe(204)
    expect(rpcCalls(f.deps, 'control_usage_ping')).toHaveLength(limit + 1)
    f.advance(86_400_000)
    expect((await send(f.app, ping)).status).toBe(204)
    expect(rpcCalls(f.deps, 'control_usage_ping')).toHaveLength(limit + 2)
    // The limiter holds a keyed hash, never the address.
    const keys = consume.mock.calls.map(([key]) => key).filter((key) => key.startsWith('usage-'))
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) expect(key).toMatch(/^usage-ping:[\w-]{22}$/)
  })

  it('reports an outage so the client tries again, and logs nothing it was sent', async () => {
    const f = setup()
    f.results.control_usage_ping = { outcome: 'nope' }
    expect((await send(f.app, ping)).status).toBe(503)
    const logged = JSON.stringify(vi.mocked(f.deps.log).mock.calls)
    expect(logged).not.toMatch(/203\.0\.113\.5|0\.1\.542|darwin|arm64/)
  })
})

describe('download redirects', () => {
  const get = (
    f: ReturnType<typeof setup>,
    path: string,
    method = 'GET',
    address = '203.0.113.5',
  ) => f.app.request(path, { method }, peer(address))

  it('redirects each artifact to its fixed GitHub target and counts it', async () => {
    const f = setup()
    f.results.control_usage_download = { outcome: 'counted' }
    for (const artifact of DOWNLOAD_ARTIFACTS) {
      const res = await get(f, `/download/${artifact}`)
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe(DOWNLOAD_TARGETS[artifact])
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get('referrer-policy')).toBe('no-referrer')
      expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    }
    expect(DOWNLOAD_TARGETS).toEqual({
      latest: 'https://github.com/agustinsacco/Phosphor/releases/latest',
      'install-sh': 'https://github.com/agustinsacco/Phosphor/releases/latest/download/install.sh',
    })
    expect(rpcCalls(f.deps, 'control_usage_download')).toEqual(
      DOWNLOAD_ARTIFACTS.map((artifact) => ['control_usage_download', { p_artifact: artifact }]),
    )
  })

  it('ignores the query, never counts HEAD, and leaves other paths to the site', async () => {
    const f = setup()
    const res = await get(f, '/download/latest?next=https://evil.example')
    expect(res.headers.get('location')).toBe(DOWNLOAD_TARGETS.latest)
    expect((await get(f, '/download/latest', 'HEAD')).status).toBe(302)
    expect(rpcCalls(f.deps, 'control_usage_download')).toHaveLength(1)
    for (const path of ['/download/', '/download/mac', '/download/latest/x', '/download/..%2fapi'])
      expect((await get(f, path)).status, path).not.toBe(302)
    expect((await get(f, '/download/latest', 'POST')).status).not.toBe(302)
    expect(rpcCalls(f.deps, 'control_usage_download')).toHaveLength(1)
  })

  it('is not served on the app origin', async () => {
    const f = fixture()
    const res = await f.app.request(origin + '/download/latest')
    expect(res.status).not.toBe(302)
    expect(rpcCalls(f.deps as never, 'control_usage_download')).toEqual([])
  })

  it('redirects without waiting on the database, and notes a lost count', async () => {
    const f = setup()
    vi.mocked(f.deps.supabase.rpc).mockImplementation(() => new Promise(() => {}))
    expect((await get(f, '/download/install-sh')).status).toBe(302)
    vi.mocked(f.deps.supabase.rpc).mockRejectedValue(new Error('down'))
    expect((await get(f, '/download/install-sh')).status).toBe(302)
    await vi.waitFor(() =>
      expect(vi.mocked(f.deps.log).mock.calls.map(([entry]) => entry)).toContainEqual(
        expect.objectContaining({
          event: 'usage.download',
          result: 'unrecorded',
          reason: 'install-sh',
        }),
      ),
    )
  })

  it('stops counting one address past its hourly limit but still redirects', async () => {
    const f = setup()
    f.results.control_usage_download = { outcome: 'counted' }
    const limit = USAGE_LIMITS.downloadsPerAddressPerHour
    for (let i = 0; i <= limit; i++) expect((await get(f, '/download/latest')).status).toBe(302)
    expect(rpcCalls(f.deps, 'control_usage_download')).toHaveLength(limit)
    await get(f, '/download/latest', 'GET', '2001:db8:1:2::9')
    expect(rpcCalls(f.deps, 'control_usage_download')).toHaveLength(limit + 1)
  })
})
