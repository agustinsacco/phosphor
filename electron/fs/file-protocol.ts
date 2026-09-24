import { protocol, type CustomScheme } from 'electron'
import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { mimeTypeForPath, previewKindForPath } from '@shared/file-kinds'

/**
 * Serving workspace files to the Files pane's viewers — images, video, audio,
 * PDFs and HTML — straight from disk.
 *
 * ## Why a protocol, and not bytes over IPC
 *
 * A video can be gigabytes. IPC would copy the whole file into the renderer
 * before the first frame, and seeking would mean holding all of it. Served
 * over a scheme with `stream: true` and Range support, `<video>` fetches only
 * what it plays, and Chromium's own PDF viewer gets a real URL to load.
 *
 * ## Why every URL carries a grant token
 *
 * The scheme never resolves a path the renderer names in the URL. Main mints
 * an unguessable token per grant (`grantPreview`), and a request resolves only
 * inside what that token covers:
 *
 * - a FILE grant (image, video, audio, PDF) serves exactly one file, whatever
 *   the URL's path says;
 * - a DOCUMENT grant (HTML) serves files under one root — the workspace — so
 *   the page's relative `style.css`, `chart.png` and `app.js` resolve. Every
 *   path is realpath'd and must stay under the root, so neither `..` nor a
 *   symlink in the tree reaches outside it.
 *
 * So no document anywhere — an artifact, a previewed page, a PDF — can name
 * an arbitrary file on disk and have this scheme read it.
 *
 * ## What a previewed HTML page can do
 *
 * It renders in `<iframe sandbox="allow-scripts">` (no `allow-same-origin`, so
 * its origin is opaque) and every response carries `documentCsp`, which also
 * applies `sandbox` itself in case a future call site forgets the attribute.
 * Verified under Electron 43:
 *
 * | vector                               | result                        |
 * | ------------------------------------ | ----------------------------- |
 * | inline + relative `<script>`         | runs                          |
 * | relative `<img>`, `<link rel=style>` | loads                         |
 * | `fetch('secret.txt')` (same grant)   | blocked (`connect-src`)       |
 * | `localStorage`                       | `SecurityError`               |
 * | `window.origin`                      | `"null"`                      |
 *
 * It can DISPLAY other workspace files as subresources but cannot READ them:
 * fetch is refused, a cross-origin image taints a canvas, and `nosniff` stops
 * a text file loading as script or style. It also has no network at all, so
 * a page that pulls a library from a CDN renders without it. That is the
 * trade: a workspace HTML file may have come from anywhere (a cloned repo, an
 * email attachment, an agent), and it sits next to `.env`.
 *
 * Navigating the frame itself away is the one channel its own CSP does not
 * govern; the app's `frame-src` and `isFrameEscape` below both close it.
 */

export const FILE_SCHEME = 'phosphor-file'

/**
 * Must be registered in the SAME `registerSchemesAsPrivileged` call as every
 * other scheme — Electron honours only one call — see main.ts.
 *
 * `stream` is what lets `<video>` issue Range requests and start playing
 * before the whole file is read. `standard` gives each token its own origin,
 * which is what the document policy's host-source matches.
 */
export const fileScheme: CustomScheme = {
  scheme: FILE_SCHEME,
  privileges: { standard: true, secure: true, stream: true, corsEnabled: false },
}

/**
 * Policy for a previewed HTML page, scoped to its own grant's origin.
 *
 * A host-source rather than `'self'`: the sandbox makes the document's origin
 * opaque, and naming the grant origin explicitly does not depend on how
 * Chromium resolves `'self'` for an opaque document. No `connect-src` (falls
 * to `default-src 'none'`), and `form-action` because a form POST is a
 * navigation that `connect-src` would not cover.
 */
function documentCsp(origin: string): string {
  return [
    "default-src 'none'",
    `script-src ${origin} 'unsafe-inline' 'unsafe-eval'`,
    `style-src ${origin} 'unsafe-inline'`,
    `img-src ${origin} data: blob:`,
    `font-src ${origin} data:`,
    `media-src ${origin} data: blob:`,
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    'sandbox allow-scripts',
  ].join('; ')
}

/**
 * Policy for a single-file grant. `<img>` and `<video>` ignore it (they are
 * subresources of the app); it matters only if one is ever loaded as a
 * document. Chromium's PDF viewer still renders under it — verified, it is
 * not a plugin block.
 */
const FILE_CSP = "default-src 'none'; sandbox"

type Grant = { kind: 'file'; path: string } | { kind: 'document'; root: string }

/** token → grant, in least-recently-granted order. */
const grants = new Map<string, Grant>()
/** grant identity → token, so re-rendering a viewer reuses its URL. */
const tokens = new Map<string, string>()

/**
 * Bounded so a long session of browsing files cannot grow main's heap. A
 * viewer whose token was evicted just 404s and shows its fallback; reopening
 * the file mints a fresh one.
 */
const MAX_GRANTS = 256

function isWithin(child: string, root: string): boolean {
  const rel = relative(root, child)
  return rel === '' || (!isAbsolute(rel) && rel.split(sep)[0] !== '..')
}

function mint(grant: Grant): string {
  const key = grant.kind === 'file' ? `file:${grant.path}` : `document:${grant.root}`
  const existing = tokens.get(key)
  const token = existing ?? randomBytes(16).toString('hex')
  // Re-insert so eviction is least-recently-USED: the file you are looking at
  // must not be the one evicted while you look at it.
  grants.delete(token)
  grants.set(token, grant)
  tokens.set(key, token)
  while (grants.size > MAX_GRANTS) {
    const oldest = grants.keys().next().value
    if (oldest === undefined) break
    const evicted = grants.get(oldest)!
    grants.delete(oldest)
    tokens.delete(evicted.kind === 'file' ? `file:${evicted.path}` : `document:${evicted.root}`)
  }
  return token
}

function encodePath(relativePath: string): string {
  return relativePath.split(sep).map(encodeURIComponent).join('/')
}

/**
 * A `phosphor-file://` URL that serves `path` to the Files pane's viewer.
 *
 * The kind is decided from the RESOLVED path, so a symlink named `x.png` that
 * points at an HTML file still gets a sandboxed document grant, never a file
 * grant served as a document.
 */
export async function grantPreview(workspacePath: string, path: string): Promise<string> {
  const real = await realpath(path)
  if (!(await stat(real)).isFile()) throw new Error(`Not a file: ${path}`)
  const kind = previewKindForPath(real)
  if (!kind) throw new Error(`No preview for this file type: ${path}`)

  if (kind === 'html') {
    const workspace = await realpath(workspacePath).catch(() => null)
    // A page opened from outside the workspace only sees its own folder.
    const root = workspace && isWithin(real, workspace) ? workspace : dirname(real)
    const token = mint({ kind: 'document', root })
    return `${FILE_SCHEME}://${token}/${encodePath(relative(root, real))}`
  }
  const token = mint({ kind: 'file', path: real })
  return `${FILE_SCHEME}://${token}/${encodeURIComponent(basename(real))}`
}

/**
 * Resolve the bytes a request is asking for, or null when its grant does not
 * cover them. Never throws for a hostile URL — every refusal is a 404.
 */
async function resolveTarget(url: URL, grant: Grant): Promise<string | null> {
  // A file grant ignores the URL's path: the name there is only for the PDF
  // viewer's title and download name.
  if (grant.kind === 'file') return grant.path
  let segments: string[]
  try {
    segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    return null // malformed %-escape
  }
  if (segments.some((s) => s.includes('\0'))) return null
  const candidate = resolve(grant.root, ...segments)
  if (!isWithin(candidate, grant.root)) return null
  const real = await realpath(candidate).catch(() => null)
  return real && isWithin(real, grant.root) ? real : null
}

type ByteRange = { start: number; end: number }

/**
 * One `bytes=` range against a file of `size` bytes.
 *
 * null means "serve the whole file" — no header, or one this does not honour
 * (multiple ranges, bad syntax), which RFC 9110 lets a server ignore.
 * 'unsatisfiable' means answer 416.
 */
export function parseRange(
  header: string | null,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, first, last] = match
  if (first === '' && last === '') return null
  if (first === '') {
    // Suffix range: the final N bytes.
    const length = Number(last)
    if (length === 0 || size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - length), end: size - 1 }
  }
  const start = Number(first)
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1)
  if (last !== '' && Number(last) < start) return null
  if (start >= size) return 'unsatisfiable'
  return { start, end }
}

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'content-security-policy': FILE_CSP },
  })
}

/** The protocol handler. Exported for tests. */
export async function serveFileRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } })
  }
  const url = new URL(request.url)
  const grant = grants.get(url.hostname)
  if (!grant) return notFound()

  const target = await resolveTarget(url, grant)
  if (!target) return notFound()
  const info = await stat(target).catch(() => null)
  if (!info?.isFile()) return notFound()

  const headers: Record<string, string> = {
    'content-type': mimeTypeForPath(target),
    'content-security-policy':
      grant.kind === 'document' ? documentCsp(`${FILE_SCHEME}://${url.hostname}`) : FILE_CSP,
    'x-content-type-options': 'nosniff',
    // Files change under an open viewer (an agent re-renders a chart); the
    // viewer re-requests with a cache-busting query, and nothing is kept.
    'cache-control': 'no-store',
    'accept-ranges': 'bytes',
  }

  const range = parseRange(request.headers.get('range'), info.size)
  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'content-range': `bytes */${info.size}` },
    })
  }
  const { start, end } = range ?? { start: 0, end: info.size - 1 }
  headers['content-length'] = String(Math.max(0, end - start + 1))
  if (range) headers['content-range'] = `bytes ${start}-${end}/${info.size}`

  const body =
    request.method === 'HEAD' || info.size === 0
      ? null
      : (Readable.toWeb(createReadStream(target, { start, end })) as ReadableStream<Uint8Array>)
  return new Response(body, { status: range ? 206 : 200, headers })
}

/** Must run AFTER `app.whenReady()`. */
export function registerFileProtocol(): void {
  protocol.handle(FILE_SCHEME, serveFileRequest)
}

/**
 * True when a sub-frame navigation would take an embedded document onto the
 * web or the local disk.
 *
 * A document's own CSP governs what it LOADS, not where its frame navigates,
 * so a previewed page (or an artifact) doing `location = 'https://…?' + data`
 * is stopped only by the EMBEDDER's `frame-src` in src/index.html. Measured:
 * that refuses it today (ERR_BLOCKED_BY_CSP, no request sent; the frame shows
 * Chromium's error page). This is the second layer, independent of that
 * policy — which a future edit may widen, and whose `'self'` is
 * http://localhost in dev. Nothing in the app frames a web page, so sub-frames
 * never need http(s) or file:. The PDF viewer's own chrome-extension frames,
 * and a previewed page following a relative link to its sibling page, are
 * untouched.
 *
 * Main-frame navigations are not this function's business — `will-navigate`
 * in main.ts already routes them to the browser. That includes a link clicked
 * inside a PDF: the viewer navigates the TOP frame, so PDF links open
 * externally like any other link.
 */
export function isFrameEscape(targetUrl: string): boolean {
  try {
    const { protocol } = new URL(targetUrl)
    return protocol === 'http:' || protocol === 'https:' || protocol === 'file:'
  } catch {
    return true
  }
}

/** Exported for tests. */
export const __testing = { grants, tokens, MAX_GRANTS, documentCsp, FILE_CSP }
