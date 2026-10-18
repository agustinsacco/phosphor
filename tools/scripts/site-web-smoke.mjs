import { fileURLToPath } from 'node:url'

const appOrigin = 'https://phosphor-app.saccolabs.com'
const siteOrigin = 'https://phosphor.saccolabs.com'
const requireCheck = (condition) => {
  if (!condition) throw new Error('Public Web smoke failed')
}

// Fixed HTTPS targets only; no OAuth, redirects, cookies, credentials or response logging.
export async function smokeWeb(fetcher = globalThis.fetch) {
  const get = (origin, path) =>
    fetcher(origin + path, {
      redirect: 'error',
      credentials: 'omit',
      signal: globalThis.AbortSignal.timeout(10_000),
    })
  const staticBody = async (path, contentType) => {
    const response = await get(appOrigin, path)
    requireCheck(response.status === 200)
    requireCheck(response.headers.get('content-type')?.startsWith(contentType))
    requireCheck(response.headers.get('cache-control') === 'no-store')
    requireCheck(response.headers.get('x-frame-options')?.toUpperCase() === 'DENY')
    const csp = response.headers.get('content-security-policy') ?? ''
    requireCheck(csp.includes('frame-src blob:') && !/frame-ancestors/i.test(csp))
    return response.text()
  }
  const root = await staticBody('/', 'text/html')
  requireCheck(root.includes('id="root"') && root.includes('/manifest.webmanifest'))
  const manifest = JSON.parse(
    await staticBody('/manifest.webmanifest', 'application/manifest+json'),
  )
  requireCheck(manifest.name === 'Phosphor' && manifest.start_url === '/' && manifest.scope === '/')
  const worker = await staticBody('/sw.js', 'application/javascript')
  requireCheck(worker.includes('fetch') && worker.includes('install') && !worker.includes('<html'))
  const session = await get(appOrigin, '/api/auth/session')
  requireCheck(session.status === 401 && session.headers.get('cache-control') === 'no-store')
  // A site response from the app tunnel (or the inverse) must not pass on title alone.
  for (const path of ['/', '/guides/']) {
    const site = await get(siteOrigin, path)
    requireCheck(site.status === 200)
    const html = await site.text()
    requireCheck(html.includes('<title>') && !html.includes('id="root"'))
    requireCheck(html.includes('href="https://phosphor-app.saccolabs.com/"'))
    requireCheck(!html.includes('/api/auth/start'))
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await smokeWeb()
    console.log('Public Web smoke passed (anonymous only; OAuth and device acceptance not tested)')
  } catch {
    // Never log upstream errors, headers or bodies (including Set-Cookie).
    console.error(
      'Public Web smoke failed: check app/site routing, static policy and session denial',
    )
    process.exitCode = 1
  }
}
