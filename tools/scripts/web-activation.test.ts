import { spawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { WEB_CALLBACK_PATTERN, WEB_PROJECT_REF, webActivation } from './web-activation.mjs'

const args = ['--project-ref', WEB_PROJECT_REF]
const token = 'fixture-management-token-never-log'
const env = { SUPABASE_ACCESS_TOKEN: token }
const projectUrl = `https://api.supabase.com/v1/projects/${WEB_PROJECT_REF}`
const authUrl = `${projectUrl}/config/auth`
const secret = 'fixture-provider-secret-never-log'
const existing = 'phosphor://callback,http://127.0.0.1:*/callback,https://existing.example/path'
const project = {
  id: WEB_PROJECT_REF,
  ref: WEB_PROJECT_REF,
  name: 'phosphor',
  status: 'ACTIVE_HEALTHY',
}

function fixture(initial: string | null = existing, identity = project) {
  let config = {
    uri_allow_list: initial,
    external_github_secret: secret,
    site_url: 'https://site.example',
  }
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url === projectUrl) return Response.json(identity)
    expect(url).toBe(authUrl)
    if (init?.method === 'PATCH') config = { ...config, ...JSON.parse(String(init.body)) }
    return Response.json(config)
  })
  const run = (apply = false) =>
    webActivation({ args: [...args, ...(apply ? ['--apply'] : [])], env, fetcher })
  const writes = () => fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH')
  return { fetcher, run, writes }
}

describe('web-activation target and transport', () => {
  it('preflights by default without writing or exposing auth configuration', async () => {
    const f = fixture()
    expect(await f.run()).toContain('dry-run only')
    expect(f.fetcher.mock.calls.map(([url]) => url)).toEqual([projectUrl, authUrl])
    expect(f.writes()).toEqual([])
    for (const [url, init] of f.fetcher.mock.calls) {
      expect(String(url).startsWith('https://api.supabase.com/')).toBe(true)
      expect(init).toMatchObject({
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(init?.signal).toBeInstanceOf(AbortSignal)
    }
  })

  it.each([
    { ...project, ref: 'anotherproject' },
    { ...project, id: 'anotherproject' },
    { ...project, name: 'other-product' },
    { ...project, status: 'PAUSED' },
    { ...project, ref: '' },
  ])(
    'refuses fetched wrong-target or unhealthy metadata before reading auth: %j',
    async (identity) => {
      const f = fixture(existing, identity)
      await expect(f.run(true)).rejects.toThrow('Refusing unverified project')
      expect(f.fetcher).toHaveBeenCalledTimes(1)
      expect(f.writes()).toEqual([])
    },
  )

  it.each([
    { input: [] },
    { input: ['--apply'] },
    { input: ['--project-ref', 'other'] },
    { input: [...args, '--apply', '--apply'] },
    { input: [...args, '--token', token] },
    { input: [...args, '--api-url', 'http://api.supabase.com'] },
    { input: [...args, '--callback', 'http://phosphor-app.saccolabs.com/api/auth/callback'] },
    { input: ['--project-ref', `http://${WEB_PROJECT_REF}`] },
  ])('refuses unsupported CLI inputs without network or input echo', async ({ input }) => {
    const f = fixture()
    await expect(webActivation({ args: input, env, fetcher: f.fetcher })).rejects.not.toThrow(token)
    expect(f.fetcher).not.toHaveBeenCalled()
  })

  it('requires the environment token, but help makes no request', async () => {
    const f = fixture()
    for (const value of [undefined, '', 'bad\ntoken'])
      await expect(
        webActivation({ args, env: { SUPABASE_ACCESS_TOKEN: value }, fetcher: f.fetcher }),
      ).rejects.toThrow('protected environment')
    expect(await webActivation({ args: ['--help'], env: {}, fetcher: f.fetcher })).toContain(
      'Usage:',
    )
    expect(f.fetcher).not.toHaveBeenCalled()
  })
})

describe('web-activation append', () => {
  it('PATCHes only uri_allow_list, preserves all entries and makes the second apply a no-op', async () => {
    const f = fixture()
    expect(await f.run(true)).toContain('appended and read back')
    expect(f.writes()).toHaveLength(1)
    for (const [url, init] of f.fetcher.mock.calls) {
      expect([projectUrl, authUrl]).toContain(url)
      expect(init).toMatchObject({ redirect: 'error', credentials: 'omit' })
    }
    const [url, init] = f.writes()[0]!
    expect(url).toBe(authUrl)
    expect(JSON.parse(String(init?.body))).toEqual({
      uri_allow_list: `${existing},${WEB_CALLBACK_PATTERN}`,
    })
    expect(String(init?.body)).not.toContain(secret)
    expect(await f.run(true)).toContain('already present; no write')
    expect(f.writes()).toHaveLength(1)
  })

  it.each(['', null, `${existing},`, `  ${existing}  `])(
    'preserves original serialized allowlist %j',
    async (initial) => {
      const f = fixture(initial)
      await f.run(true)
      expect(JSON.parse(String(f.writes()[0]![1]?.body))).toEqual({
        uri_allow_list: initial ? `${initial},${WEB_CALLBACK_PATTERN}` : WEB_CALLBACK_PATTERN,
      })
    },
  )

  it('recognizes an exact entry with whitespace without normalizing other entries', async () => {
    const f = fixture(`${existing}, ${WEB_CALLBACK_PATTERN} `)
    expect(await f.run(true)).toContain('already present')
    expect(f.writes()).toEqual([])
  })

  it('pins the callback path with a literal query delimiter and single-segment state wildcard', () => {
    expect(WEB_CALLBACK_PATTERN).toBe(
      'https://phosphor-app.saccolabs.com/api/auth/callback\\?state=*',
    )
    expect(WEB_CALLBACK_PATTERN).not.toContain('**')
  })

  it('refuses stale allowlists rather than overwriting a concurrent edit', async () => {
    const f = fixture()
    f.fetcher
      .mockResolvedValueOnce(Response.json(project))
      .mockResolvedValueOnce(Response.json({ uri_allow_list: existing }))
      .mockResolvedValueOnce(Response.json({ uri_allow_list: `${existing},https://new.example` }))
    await expect(f.run(true)).rejects.toThrow('changed during preflight; no write')
    expect(f.writes()).toEqual([])
  })

  it('requires readback and reports uncertain post-write outcomes without rollback', async () => {
    const f = fixture()
    f.fetcher
      .mockResolvedValueOnce(Response.json(project))
      .mockResolvedValueOnce(Response.json({ uri_allow_list: existing }))
      .mockResolvedValueOnce(Response.json({ uri_allow_list: existing }))
      .mockResolvedValueOnce(
        Response.json({ uri_allow_list: `${existing},${WEB_CALLBACK_PATTERN}` }),
      )
      .mockResolvedValueOnce(Response.json({ uri_allow_list: existing }))
    await expect(f.run(true)).rejects.toThrow('verification failed after PATCH')
    expect(f.writes()).toHaveLength(1)
  })
})

describe('web-activation secret-safe failures', () => {
  it.each([301, 302, 307, 308, 401, 403, 429, 500])(
    'refuses HTTP %i without reading or printing the body',
    async (status) => {
      const f = fixture()
      const response = new Response(`${token} ${secret}`, {
        status,
        headers: { Location: `http://evil.example/${token}` },
      })
      const reader = vi.spyOn(response.body!, 'getReader')
      f.fetcher.mockResolvedValueOnce(response)
      await expect(f.run(true)).rejects.toThrow('Management API request refused')
      expect(reader).not.toHaveBeenCalled()
      expect(f.fetcher).toHaveBeenCalledTimes(1)
    },
  )

  it('refuses a PATCH redirect without following or retrying it', async () => {
    const f = fixture()
    f.fetcher
      .mockResolvedValueOnce(Response.json(project))
      .mockResolvedValueOnce(Response.json({ uri_allow_list: existing }))
      .mockResolvedValueOnce(Response.json({ uri_allow_list: existing }))
      .mockResolvedValueOnce(
        new Response(secret, { status: 302, headers: { Location: 'https://other.example' } }),
      )
    await expect(f.run(true)).rejects.toThrow('Management API request refused')
    expect(f.writes()).toHaveLength(1)
    expect(f.fetcher).toHaveBeenCalledTimes(4)
  })

  it.each(['redirected', 'url'])(
    'refuses followed or non-HTTPS response metadata: %s',
    async (field) => {
      const f = fixture()
      const response = Response.json(project)
      Object.defineProperty(response, field, {
        value: field === 'url' ? 'http://api.supabase.com' : true,
      })
      f.fetcher.mockResolvedValueOnce(response)
      await expect(f.run(true)).rejects.toThrow('Management API request refused')
      expect(f.writes()).toEqual([])
    },
  )

  it('sanitizes network, malformed JSON and oversized response failures', async () => {
    for (const response of [
      new Error(`${token} ${secret}`),
      new Response(`{${secret}`),
      new Response(secret.repeat(60_000)),
    ]) {
      const f = fixture()
      if (response instanceof Error) f.fetcher.mockRejectedValueOnce(response)
      else f.fetcher.mockResolvedValueOnce(response)
      const error = await f.run(true).catch((value: Error) => value)
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).not.toContain(secret)
      expect(String(error)).not.toContain(token)
      expect((error as Error).cause).toBeUndefined()
      expect(f.writes()).toEqual([])
    }
  })

  it.each([{}, { uri_allow_list: [] }, { uri_allow_list: 123 }, null])(
    'fails closed on invalid auth shape %j',
    async (config) => {
      const f = fixture()
      f.fetcher
        .mockResolvedValueOnce(Response.json(project))
        .mockResolvedValueOnce(Response.json(config))
      await expect(f.run(true)).rejects.toThrow(
        /Invalid (auth configuration|OAuth allowlist) response/,
      )
      expect(f.writes()).toEqual([])
    },
  )

  it('CLI errors never echo argv credentials and require no local credential store', () => {
    const result = spawnSync(
      process.execPath,
      ['tools/scripts/web-activation.mjs', ...args, '--token', secret],
      { encoding: 'utf8', env: {} },
    )
    expect(result.status).toBe(1)
    expect(result.stdout + result.stderr).toContain('Usage:')
    expect(result.stdout + result.stderr).not.toContain(secret)
  })
})
