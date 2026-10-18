import { describe, expect, it } from 'vitest'
import { smokeWeb } from './site-web-smoke.mjs'

const app = 'https://phosphor-app.saccolabs.com'
const site = 'https://phosphor.saccolabs.com'
const appHtml = '<title>Phosphor</title><div id="root"></div><link href="/manifest.webmanifest">'
const siteHtml =
  '<title>Phosphor site</title><a href="https://phosphor-app.saccolabs.com/">Open the app</a>'
const headers = {
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; frame-src blob:",
}

function fixture(change?: (url: string, response: Response) => Response) {
  const calls: string[] = []
  const fetcher: typeof fetch = async (input, options) => {
    const url = String(input)
    calls.push(url)
    expect(url.startsWith('https://')).toBe(true)
    expect(options?.redirect).toBe('error')
    expect(options?.credentials).toBe('omit')
    expect(options?.headers).toBeUndefined()
    expect(options?.signal).toBeInstanceOf(AbortSignal)
    const path = new URL(url).pathname
    let body = appHtml
    let type = 'text/html'
    if (url.startsWith(site)) body = siteHtml
    else if (path === '/manifest.webmanifest') {
      body = JSON.stringify({ name: 'Phosphor', start_url: '/', scope: '/' })
      type = 'application/manifest+json'
    } else if (path === '/sw.js') {
      body = 'self.addEventListener("install",()=>{});self.addEventListener("fetch",()=>{})'
      type = 'application/javascript'
    } else if (path === '/api/auth/session') {
      body = '{"error":"unauthenticated"}'
      type = 'application/json'
    }
    const response = new Response(body, {
      status: path === '/api/auth/session' ? 401 : 200,
      headers: { ...headers, 'content-type': type },
    })
    return change?.(url, response) ?? response
  }
  return { calls, fetcher }
}

describe('site-web-smoke', () => {
  it('checks both origins without requesting OAuth or forwarding cookies', async () => {
    const { calls, fetcher } = fixture()
    await smokeWeb(fetcher)
    expect(calls).toEqual([
      app + '/',
      app + '/manifest.webmanifest',
      app + '/sw.js',
      app + '/api/auth/session',
      site + '/',
      site + '/guides/',
    ])
  })

  it.each(['cache-control', 'x-frame-options', 'content-security-policy'])(
    'refuses missing %s',
    async (name) => {
      const { fetcher } = fixture((_url, response) => {
        response.headers.delete(name)
        return response
      })
      await expect(smokeWeb(fetcher)).rejects.toThrow('Public Web smoke failed')
    },
  )

  it.each([
    'site-on-app',
    'app-on-site',
    'frame-ancestors',
    'session-200',
    'worker-html',
    'missing-link',
    'redirect',
  ])('refuses %s', async (problem) => {
    const { fetcher } = fixture((url, response) => {
      if (problem === 'site-on-app' && url === app + '/')
        return new Response(siteHtml, { headers: response.headers })
      if (problem === 'app-on-site' && url === site + '/') return new Response(appHtml)
      if (problem === 'frame-ancestors')
        response.headers.append('content-security-policy', "frame-ancestors 'none'")
      if (problem === 'session-200' && url.endsWith('/api/auth/session'))
        return new Response('{}', { headers: response.headers })
      if (problem === 'worker-html' && url.endsWith('/sw.js'))
        return new Response('<html>install fetch</html>', { headers: response.headers })
      if (problem === 'missing-link' && url === site + '/guides/')
        return new Response('<title>Guides</title>')
      if (problem === 'redirect') return new Response(null, { status: 302 })
      return response
    })
    await expect(smokeWeb(fetcher)).rejects.toThrow('Public Web smoke failed')
  })
})
