import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// electron is not loadable under vitest; the grant and serving logic is plain
// Node over a real temp directory. What Chromium does with the responses (the
// sandbox, the CSP, the PDF viewer) was measured directly — see the module
// comment.
vi.mock('electron', () => ({ protocol: { handle: vi.fn() } }))

const { grantPreview, serveFileRequest, parseRange, isFrameEscape, __testing } =
  await import('./file-protocol')

let root: string
let workspace: string
let outside: string

beforeAll(async () => {
  // realpath: macOS tmpdir is behind a /var → /private/var symlink, and the
  // grants store resolved paths.
  root = await realpath(await mkdtemp(join(tmpdir(), 'phosphor-file-protocol-')))
  workspace = join(root, 'workspace')
  outside = join(root, 'outside')
  await mkdir(join(workspace, 'site', 'assets'), { recursive: true })
  await mkdir(outside)
  await writeFile(join(workspace, 'clip.mp4'), '0123456789')
  await writeFile(join(workspace, 'doc.pdf'), '%PDF-1.4 fake')
  await writeFile(join(workspace, 'notes.txt'), 'plain text')
  await writeFile(join(workspace, '.env'), 'SECRET=1')
  await writeFile(join(workspace, 'site', 'index.html'), '<link href="assets/app.css">')
  await writeFile(join(workspace, 'site', 'assets', 'app.css'), 'body{}')
  await writeFile(join(workspace, 'site', 'my page.html'), '<p>spaces</p>')
  await writeFile(join(outside, 'secret.txt'), 'outside the workspace')
  await writeFile(join(outside, 'page.html'), '<p>outside</p>')
  await symlink(join(outside, 'secret.txt'), join(workspace, 'site', 'escape.txt'))
  // Named like an image, resolves to a page.
  await symlink(join(workspace, 'site', 'index.html'), join(workspace, 'disguised.png'))
})

afterAll(() => rm(root, { recursive: true, force: true }))

beforeEach(() => {
  __testing.grants.clear()
  __testing.tokens.clear()
})

const get = (url: string, headers: Record<string, string> = {}) =>
  serveFileRequest(new Request(url, { headers }))

// Node gives a non-special scheme an opaque origin ("null"); Electron's
// `standard` privilege is what makes it hierarchical in the app.
const originOf = (url: string) => `phosphor-file://${new URL(url).hostname}`

describe('grantPreview', () => {
  it('grants a single file by token, with its name in the path', async () => {
    const url = await grantPreview(workspace, join(workspace, 'clip.mp4'))
    expect(url).toMatch(/^phosphor-file:\/\/[0-9a-f]{32}\/clip\.mp4$/)
  })

  it('reuses the grant, so a re-render does not reload the viewer', async () => {
    const a = await grantPreview(workspace, join(workspace, 'clip.mp4'))
    const b = await grantPreview(workspace, join(workspace, 'clip.mp4'))
    expect(a).toBe(b)
    expect(__testing.grants.size).toBe(1)
  })

  it('gives different files different tokens', async () => {
    const a = new URL(await grantPreview(workspace, join(workspace, 'clip.mp4'))).hostname
    const b = new URL(await grantPreview(workspace, join(workspace, 'doc.pdf'))).hostname
    expect(a).not.toBe(b)
  })

  it('grants HTML the workspace, addressed by its relative path', async () => {
    const url = await grantPreview(workspace, join(workspace, 'site', 'my page.html'))
    expect(url).toMatch(/^phosphor-file:\/\/[0-9a-f]{32}\/site\/my%20page\.html$/)
    // Every page in the workspace shares one document grant.
    const other = await grantPreview(workspace, join(workspace, 'site', 'index.html'))
    expect(new URL(other).hostname).toBe(new URL(url).hostname)
  })

  it('scopes a page from outside the workspace to its own folder', async () => {
    const url = await grantPreview(workspace, join(outside, 'page.html'))
    expect(url).toMatch(/\/page\.html$/)
    const response = await get(url.replace('/page.html', '/secret.txt'))
    expect(await response.text()).toBe('outside the workspace')
    const grant = __testing.grants.get(new URL(url).hostname)
    expect(grant).toEqual({ kind: 'document', root: outside })
  })

  it('decides the grant from the resolved file, not the link name', async () => {
    // A file grant would serve the page unsandboxed-by-policy; it must get
    // the document grant (and its CSP) instead.
    const url = await grantPreview(workspace, join(workspace, 'disguised.png'))
    expect(__testing.grants.get(new URL(url).hostname)?.kind).toBe('document')
  })

  it('refuses a type with no viewer, and a directory', async () => {
    await expect(grantPreview(workspace, join(workspace, 'notes.txt'))).rejects.toThrow()
    await expect(grantPreview(workspace, join(workspace, 'site'))).rejects.toThrow()
    await expect(grantPreview(workspace, join(workspace, 'missing.png'))).rejects.toThrow()
  })

  it('evicts the least recently used grant past the cap', async () => {
    const first = await grantPreview(workspace, join(workspace, 'clip.mp4'))
    for (let i = 0; i < __testing.MAX_GRANTS; i++) {
      __testing.grants.set(`filler${i}`, { kind: 'file', path: `/filler/${i}` })
      __testing.tokens.set(`file:/filler/${i}`, `filler${i}`)
    }
    await grantPreview(workspace, join(workspace, 'doc.pdf'))
    expect(__testing.grants.size).toBe(__testing.MAX_GRANTS)
    expect(__testing.grants.has(new URL(first).hostname)).toBe(false)
    expect((await get(first)).status).toBe(404)
  })
})

describe('serveFileRequest', () => {
  it('404s an unknown token', async () => {
    expect((await get('phosphor-file://0123456789abcdef0123456789abcdef/clip.mp4')).status).toBe(
      404,
    )
  })

  it('serves a file grant whatever path the URL names', async () => {
    const url = await grantPreview(workspace, join(workspace, 'clip.mp4'))
    const response = await get(`${originOf(url)}/.env`)
    expect(await response.text()).toBe('0123456789')
    expect(response.headers.get('content-type')).toBe('video/mp4')
  })

  it('serves a file grant under a locked-down policy with nosniff', async () => {
    const response = await get(await grantPreview(workspace, join(workspace, 'doc.pdf')))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toBe(__testing.FILE_CSP)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('serves a page and its relative assets under the page policy', async () => {
    const page = new URL(await grantPreview(workspace, join(workspace, 'site', 'index.html')))
    const response = await get(page.href)
    const csp = response.headers.get('content-security-policy')!
    expect(csp).toBe(__testing.documentCsp(`phosphor-file://${page.hostname}`))
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain('sandbox allow-scripts')
    expect(csp).not.toContain('connect-src')
    const css = await get(new URL('assets/app.css', page).href)
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(await css.text()).toBe('body{}')
  })

  it('decodes %-escaped names', async () => {
    const response = await get(
      await grantPreview(workspace, join(workspace, 'site', 'my page.html')),
    )
    expect(await response.text()).toBe('<p>spaces</p>')
  })

  it('refuses every way out of a document grant', async () => {
    const origin = originOf(await grantPreview(workspace, join(workspace, 'site', 'index.html')))
    for (const path of [
      '/../outside/secret.txt', // normalised by the URL parser, still refused
      '/%2e%2e/outside/secret.txt',
      '/site/..%2F..%2Foutside%2Fsecret.txt', // an escaped separator
      '/site/escape.txt', // a symlink inside the tree pointing out of it
      '/site/%00index.html',
      '/site/%E0%A4%A.html', // malformed escape
      '/missing.html',
      '/site', // a directory
    ]) {
      const response = await get(`${origin}${path}`)
      expect(response.status, path).toBe(404)
      expect(await response.text()).not.toContain('outside the workspace')
    }
  })

  it('answers a range with 206 and exactly those bytes', async () => {
    const url = await grantPreview(workspace, join(workspace, 'clip.mp4'))
    const response = await get(url, { range: 'bytes=2-5' })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(response.headers.get('content-length')).toBe('4')
    expect(await response.text()).toBe('2345')
  })

  it('advertises ranges and serves the whole file without one', async () => {
    const response = await get(await grantPreview(workspace, join(workspace, 'clip.mp4')))
    expect(response.status).toBe(200)
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('content-length')).toBe('10')
  })

  it('answers an unsatisfiable range with 416', async () => {
    const url = await grantPreview(workspace, join(workspace, 'clip.mp4'))
    const response = await get(url, { range: 'bytes=10-' })
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe('bytes */10')
  })

  it('answers HEAD without a body, and refuses other methods', async () => {
    const url = await grantPreview(workspace, join(workspace, 'clip.mp4'))
    const head = await serveFileRequest(new Request(url, { method: 'HEAD' }))
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('10')
    expect(head.body).toBeNull()
    const post = await serveFileRequest(new Request(url, { method: 'POST', body: 'x' }))
    expect(post.status).toBe(405)
  })
})

describe('parseRange', () => {
  it.each([
    [null, 100, null],
    ['bytes=0-9', 100, { start: 0, end: 9 }],
    ['bytes=90-', 100, { start: 90, end: 99 }],
    ['bytes=90-500', 100, { start: 90, end: 99 }], // end clamped to the file
    ['bytes=-10', 100, { start: 90, end: 99 }], // suffix
    ['bytes=-500', 100, { start: 0, end: 99 }],
    ['bytes=100-', 100, 'unsatisfiable'],
    ['bytes=-0', 100, 'unsatisfiable'],
    ['bytes=0-', 0, 'unsatisfiable'],
    ['bytes=5-2', 100, null], // invalid: ignored, whole file
    ['bytes=0-1,5-6', 100, null], // multiple ranges: ignored, whole file
    ['items=0-1', 100, null],
    ['bytes=-', 100, null],
  ])('%s of %i bytes → %j', (header, size, expected) => {
    expect(parseRange(header, size)).toEqual(expected)
  })
})

describe('isFrameEscape', () => {
  it.each([
    ['https://example.com/?leak=1', true],
    ['http://localhost:5173/', true],
    ['file:///etc/passwd', true],
    ['not a url', true],
    ['phosphor-file://0123abcd/site/page2.html', false],
    ['phosphor-artifact://doc/abc', false],
    // Chromium's PDF viewer navigates its own frames here.
    ['chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html', false],
    ['about:blank', false],
    ['about:srcdoc', false],
  ])('%s → %s', (url, expected) => {
    expect(isFrameEscape(url)).toBe(expected)
  })
})
