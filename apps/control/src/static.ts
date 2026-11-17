import { open, realpath, type FileHandle } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { staticResponse } from './static-response'

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
  '.xml': 'application/xml',
}
const inside = (root: string, path: string) => path.startsWith(root + sep)
const hidden = (path: string) => path.split(/[\\/]/).some((part) => part.startsWith('.'))

/**
 * The web app's document policy. Its blob: images and media are Host files the page itself
 * read into memory and typed by extension (apps/web/src/platform/file-bytes.ts); they never
 * load from the network.
 */
const WEB_APP_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src blob:; font-src 'self'; connect-src 'self' https://*.ts.net:* wss://*.ts.net:*; manifest-src 'self'; worker-src 'self'; frame-src blob:; base-uri 'none'; form-action 'self'"

export async function serveStatic(
  request: Request,
  siteDir: string,
  rejectPath = false,
  web = false,
): Promise<Response> {
  const headers = new Headers({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  })
  if (web) {
    headers.set('Cache-Control', 'no-store')
    headers.set('Referrer-Policy', 'no-referrer')
    // WebKit inherits CSP frame-ancestors into Blob previews and refuses them.
    // DENY protects the app from framing without propagating into opaque Blobs.
    headers.set('X-Frame-Options', 'DENY')
    headers.set('Content-Security-Policy', WEB_APP_POLICY)
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    headers.set('Allow', 'GET, HEAD')
    return new Response(null, { status: 405, headers })
  }
  async function file(
    root: string,
    path: string,
    status: number,
    immutable: boolean,
  ): Promise<Response | null> {
    let handle: FileHandle | undefined
    try {
      const resolved = await realpath(path)
      if (!inside(root, resolved) || hidden(resolved.slice(root.length + 1))) return null
      handle = await open(resolved, 'r')
      const stat = await handle.stat()
      if (!stat.isFile()) {
        await handle.close()
        return null
      }
      const type = types[extname(resolved)] ?? 'application/octet-stream'
      headers.set('Content-Type', type)
      if (immutable && status === 200)
        headers.set('Cache-Control', 'public, max-age=31536000, immutable')
      return await staticResponse(handle, request, headers, status, stat.size)
    } catch {
      await handle?.close()
      return null
    }
  }
  let root: string
  try {
    root = await realpath(siteDir)
  } catch {
    return new Response(null, { status: 404, headers })
  }
  let path: string
  try {
    if (rejectPath) throw new Error('unsafe raw path')
    const encoded = new URL(request.url).pathname
    if (/%(?:2f|5c|00)/i.test(encoded)) throw new Error('unsafe path')
    path = decodeURIComponent(encoded)
    if (path.includes('\0') || path.includes('\\') || hidden(path)) throw new Error('unsafe path')
  } catch {
    return (
      (await file(root, resolve(root, '404.html'), 404, false)) ??
      new Response(null, { status: 404, headers })
    )
  }
  // Keep the site's existing guide redirect relative to the public origin.
  if (!web && /^\/guides\/claude-code\/?$/.test(path))
    return new Response(null, {
      status: 301,
      headers: { ...Object.fromEntries(headers), Location: '/guides/accounts/' },
    })
  const candidate = resolve(root, `.${path}`)
  if (candidate !== root && !inside(root, candidate))
    return new Response(null, { status: 404, headers })
  const immutable = !web && (path.startsWith('/_astro/') || path.startsWith('/fonts/'))
  const direct = await file(root, candidate, 200, immutable)
  if (direct) return direct
  if (!immutable) {
    const index = await file(root, resolve(candidate, 'index.html'), 200, false)
    if (index) return index
  }
  if (
    web &&
    path !== '/api' &&
    !path.startsWith('/api/') &&
    /^\/(?:[A-Za-z0-9_-]+\/?)*$/.test(path) &&
    !/^\/(?:assets|fonts|icons|_astro)(?:\/|$)/.test(path) &&
    request.headers.get('accept')?.includes('text/html')
  ) {
    const index = await file(root, resolve(root, 'index.html'), 200, false)
    if (index) return index
  }
  return (
    (await file(root, resolve(root, '404.html'), 404, false)) ??
    new Response(null, { status: 404, headers })
  )
}
