import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gunzipSync } from 'node:zlib'
import { createApp } from './app'
import { serveStatic } from './static'
import { dependencies } from './test-support'
import { parseConfig } from './config'

let root = ''
let site = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'phosphor-control-'))
  site = join(root, 'site')
  await mkdir(join(site, 'guides'), { recursive: true })
  await mkdir(join(site, '_astro'))
  await mkdir(join(site, 'fonts'))
  await mkdir(join(site, 'empty'))
  await Promise.all(
    [
      ['index.html', 'home'],
      ['guides/index.html', 'guide'],
      ['404.html', 'not found'],
      ['_astro/x.js', 'x'.repeat(1025)],
      ['fonts/x.woff2', 'font'],
      ['.hidden', 'secret'],
    ].map(([name, body]) => writeFile(join(site, name ?? ''), body ?? '')),
  )
  await writeFile(join(root, 'outside'), 'secret')
  await symlink(join(root, 'outside'), join(site, 'leak'))
  await symlink(root, join(site, 'outdir'))
  await symlink(join(site, '.hidden'), join(site, 'hidden-link'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
describe('Static nginx parity', () => {
  it('serves index files, misses with custom 404, HEAD, relative legacy redirect and no framework branding', async () => {
    const deps = dependencies()
    deps.config = parseConfig({ SITE_DIR: site })
    const app = createApp(deps)
    for (const [path, body, status] of [
      ['/', 'home', 200],
      ['/guides', 'guide', 200],
      ['/guides/', 'guide', 200],
      ['/missing', 'not found', 404],
      ['/empty', 'not found', 404],
    ] as const) {
      const res = await app.request(path ?? '/')
      expect(res.status).toBe(status)
      expect(await res.text()).toBe(body)
      expect(res.headers.get('x-request-id')).toMatch(/^[a-f0-9]{32}$/)
      expect(res.headers.get('x-powered-by')).toBeNull()
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
    }
    const head = await app.request('/guides', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    expect(head.headers.get('content-length')).toBe('5')
    expect((await app.request('/guides', { method: 'POST' })).status).toBe(405)
    expect((await app.request('/guides/claude-code')).headers.get('location')).toBe(
      '/guides/accounts/',
    )
  })
  it('caches assets immutably and gzips only text above 1 KB, respecting q=0', async () => {
    for (const path of ['/_astro/x.js', '/fonts/x.woff2']) {
      expect(
        (
          await serveStatic(new Request('http://localhost' + path, { method: 'HEAD' }), site)
        ).headers.get('cache-control'),
      ).toBe('public, max-age=31536000, immutable')
    }
    const res = await serveStatic(
      new Request('http://localhost/_astro/x.js', { headers: { 'accept-encoding': 'gzip' } }),
      site,
    )
    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(gunzipSync(Buffer.from(await res.arrayBuffer())).toString()).toBe('x'.repeat(1025))
    for (const [path, encoding] of [
      ['/_astro/x.js', 'gzip;q=0'],
      ['/', 'gzip'],
      ['/fonts/x.woff2', 'gzip'],
    ]) {
      const plain = await serveStatic(
        new Request('http://localhost' + path, { headers: { 'accept-encoding': encoding ?? '' } }),
        site,
      )
      expect(plain.headers.get('content-encoding')).toBeNull()
      await plain.arrayBuffer()
    }
    await writeFile(join(site, '_astro/boundary.js'), 'x'.repeat(1024))
    const exact = await serveStatic(
      new Request('http://localhost/_astro/boundary.js', {
        headers: { 'accept-encoding': 'gzip' },
      }),
      site,
    )
    expect(exact.headers.get('content-encoding')).toBeNull()
    await exact.arrayBuffer()
  })
  it('rejects traversal, separators, null bytes, dotfiles, outside symlinks and directory listing', async () => {
    for (const path of [
      '/../outside',
      '/%2e%2e/outside',
      '/%2e%2e%2foutside',
      '/%2foutside',
      '/guides%2findex.html',
      '/%5coutside',
      '/x%00',
      '/%zz',
      '/.hidden',
      '/hidden-link',
      '/leak',
      '/outdir/outside',
      '/empty/',
      '/_astro/',
    ]) {
      const res = await serveStatic(
        new Request('http://localhost' + path, { method: 'HEAD' }),
        site,
      )
      expect(res.status, path).toBe(404)
      expect(await res.text(), path).not.toContain('secret')
    }
    expect(
      (await serveStatic(new Request('http://localhost/'), join(root, 'missing'))).status,
    ).toBe(404)
  })
})

it('checks raw targets before normalization for injected bindings, site and API', async () => {
  const deps = dependencies()
  deps.config = parseConfig({ SITE_DIR: site })
  const app = createApp(deps)
  for (const target of [
    '/../',
    '/./',
    '/%2e%2E/',
    '/a%2fb',
    '/a%5Cb',
    '/a\\b',
    '/a%00b',
    '/a\0b',
    '//guides',
    '/guides//',
  ]) {
    const res = await app.request('http://localhost/', {}, { incoming: { url: target } })
    expect(res.status, target).toBe(404)
    expect(await res.text()).toBe('not found')
  }
  const res = await app.request('http://localhost/', {}, { incoming: { url: '/api/../' } })
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: { code: 'bad-request', message: 'bad-request' } })
  expect(res.headers.get('cache-control')).toBe('no-store')
})

it('direct HEAD serving allocates no response body', async () => {
  const res = await serveStatic(new Request('http://localhost/guides', { method: 'HEAD' }), site)
  expect(await res.text()).toBe('')
  expect(res.body).toBeNull()
  expect(res.headers.get('content-length')).toBe('5')
})
