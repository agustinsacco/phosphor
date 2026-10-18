import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { expect, it } from 'vitest'
import { createApp } from '../app'
import { parseConfig } from '../config'
import { dependencies } from '../test-support'

it('isolates static roots and CSP, limits SPA fallback, and preserves confinement/HEAD', async () => {
  const root = await mkdtemp(join(tmpdir(), 'control-web-'))
  try {
    const site = join(root, 'site'),
      web = join(root, 'web')
    await mkdir(join(site, 'guides'), { recursive: true })
    await mkdir(web)
    await writeFile(join(site, 'index.html'), 'marketing')
    await writeFile(join(site, 'guides/index.html'), 'guides')
    await writeFile(join(web, 'index.html'), 'app')
    await symlink(join(site, 'index.html'), join(web, 'escape.html'))
    const deps = dependencies()
    deps.config = parseConfig({
      SITE_DIR: site,
      WEB_DIR: web,
      CONTROL_WEB_ORIGIN: 'https://app.example.test',
      CONTROL_WEB_SESSION_KEYS: `test=${randomBytes(32).toString('base64url')}`,
      SUPABASE_SECRET_KEY: 'fixture',
    })
    const app = createApp(deps)
    const request = (path: string, method = 'GET') =>
      app.request('https://app.example.test' + path, { method, headers: { accept: 'text/html' } })
    expect(await (await app.request('https://site.example.test/')).text()).toBe('marketing')
    expect(await (await app.request('https://site.example.test/guides/')).text()).toBe('guides')
    expect(await (await request('/')).text()).toBe('app')
    expect(await (await request('/machines/active')).text()).toBe('app')
    for (const path of [
      '/assets/missing',
      '/missing.js',
      '/api/missing',
      '/api',
      '/_astro/missing',
      '/escape.html',
      '/.hidden',
    ])
      expect((await request(path)).status, path).toBe(404)
    expect(await (await request('/machines', 'HEAD')).text()).toBe('')
    expect((await request('/machines', 'POST')).status).toBe(405)
    const appResponse = await request('/')
    expect(appResponse.headers.get('x-frame-options')).toBe('DENY')
    const policy = appResponse.headers.get('content-security-policy')!
    expect(policy).not.toContain('frame-ancestors')
    expect(policy).toContain("script-src 'self';")
    expect(policy).toContain('frame-src blob:;')
    expect(policy).not.toContain("frame-src 'self'")
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'")
    expect(policy).toContain("connect-src 'self' https://*.ts.net:* wss://*.ts.net:*")
    expect(policy).not.toContain('http:')
    expect(
      policy
        .split(';')
        .map((rule) => rule.trim())
        .find((rule) => rule.startsWith('frame-src')),
    ).toBe('frame-src blob:')
    expect(
      (await app.request('https://site.example.test/')).headers.get('content-security-policy'),
    ).toBeNull()
    expect((await request('/api/v1/health')).headers.get('content-security-policy')).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('requires all opt-in settings, distinct origins and strong keys; HTTP only literal loopback', () => {
  const settings = {
    CONTROL_WEB_ORIGIN: 'https://app.example.test',
    WEB_DIR: '/web',
    CONTROL_WEB_SESSION_KEYS: `test=${randomBytes(32).toString('base64url')}`,
  }
  expect(parseConfig({}).web).toBeNull()
  for (const key of Object.keys(settings))
    expect(() => parseConfig({ ...settings, [key]: undefined })).toThrow()
  for (const origin of [
    'https://phosphor.saccolabs.com',
    'https://app.example.test/path',
    'http://app.example.test',
    'http://localhost:5015',
    'https://user:pass@app.example.test',
  ])
    expect(() => parseConfig({ ...settings, CONTROL_WEB_ORIGIN: origin })).toThrow()
  expect(
    parseConfig({ ...settings, CONTROL_WEB_ORIGIN: 'http://127.0.0.1:5015' }).web?.development,
  ).toBe(true)
  expect(() => parseConfig({ ...settings, CONTROL_WEB_SESSION_KEYS: 'weak=secret' })).toThrow(
    'Invalid browser authentication configuration',
  )
})
