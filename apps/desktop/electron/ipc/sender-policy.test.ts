import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, expect, it, vi } from 'vitest'

interface FakeFrame {
  url: string
}
interface FakeContents {
  mainFrame: FakeFrame
  isDestroyed: () => boolean
}
interface FakeWindow {
  webContents: FakeContents
  isDestroyed: () => boolean
}

const electron = vi.hoisted(() => ({
  owners: new Map<FakeContents, FakeWindow>(),
  app: { isPackaged: true, getAppPath: (): string => '' },
}))
vi.mock('electron', () => ({
  app: electron.app,
  BrowserWindow: {
    fromWebContents: (contents: FakeContents) => electron.owners.get(contents) ?? null,
  },
}))
import {
  admitSender,
  isRendererDocument,
  rendererDocument,
  UNTRUSTED_SENDER,
  type InvokeSender,
  type RendererDocument,
} from './sender-policy'

// A space and a non-ASCII letter: Chromium and Node must agree on their encoding.
const root = mkdtempSync(join(tmpdir(), 'phosphor-policy-'))
const appPath = join(root, 'Phosphör app')
mkdirSync(appPath)
const INDEX_PATH = join(realpathSync(appPath), 'out', 'renderer', 'index.html')
const INDEX_URL = pathToFileURL(INDEX_PATH).href
const DEV_URL = 'http://localhost:5173'
const BUNDLE: RendererDocument = { kind: 'bundle', path: INDEX_PATH }
const DEV: RendererDocument = { kind: 'dev-server', origin: DEV_URL }

electron.app.getAppPath = () => appPath
afterAll(() => rmSync(root, { recursive: true, force: true }))
afterEach(() => {
  electron.app.isPackaged = true
  electron.app.getAppPath = () => appPath
  vi.unstubAllEnvs()
})

/** The invoke event a live window sends from its own main frame while showing `url`. */
function windowEvent(url: string): { sender: FakeContents; senderFrame: FakeFrame | null } {
  const mainFrame: FakeFrame = { url }
  const sender: FakeContents = { mainFrame, isDestroyed: () => false }
  electron.owners.set(sender, { webContents: sender, isDestroyed: () => false })
  return { sender, senderFrame: mainFrame }
}

/** True when admitSender lets the event through; any other throw fails the test. */
function admits(event: unknown): boolean {
  try {
    admitSender(event as InvokeSender)
    return true
  } catch (error) {
    if (error instanceof Error && error.message === UNTRUSTED_SENDER) return false
    throw error
  }
}

function devRun(): void {
  electron.app.isPackaged = false
  vi.stubEnv('ELECTRON_RENDERER_URL', DEV_URL)
}

it('admits only the live main frame of a window that owns its contents', () => {
  expect(admits(windowEvent(INDEX_URL))).toBe(true)
  const orphan = windowEvent(INDEX_URL)
  electron.owners.delete(orphan.sender)
  expect(admits(orphan)).toBe(false)
  const closed = windowEvent(INDEX_URL)
  const window = electron.owners.get(closed.sender)
  if (window) window.isDestroyed = () => true
  expect(admits(closed)).toBe(false)
  const crashed = windowEvent(INDEX_URL)
  crashed.sender.isDestroyed = () => true
  expect(admits(crashed)).toBe(false)
  const hosted = windowEvent(INDEX_URL)
  electron.owners.set(hosted.sender, {
    webContents: windowEvent(INDEX_URL).sender,
    isDestroyed: () => false,
  })
  expect(admits(hosted)).toBe(false)
  expect(admits({ ...windowEvent(INDEX_URL), senderFrame: { url: INDEX_URL } })).toBe(false)
  expect(admits({ ...windowEvent(INDEX_URL), senderFrame: null })).toBe(false)
  expect(admits({})).toBe(false)
  expect(admits(undefined)).toBe(false)
})

it('packaged: refuses a sibling bundle file, a file elsewhere and a web page', () => {
  expect(admits(windowEvent(new URL('other.html', INDEX_URL).href))).toBe(false)
  expect(admits(windowEvent(new URL('../main/index.html', INDEX_URL).href))).toBe(false)
  expect(admits(windowEvent(pathToFileURL('/tmp/index.html').href))).toBe(false)
  expect(admits(windowEvent('https://example.com/out/renderer/index.html'))).toBe(false)
  expect(admits(windowEvent(`${DEV_URL}/`))).toBe(false)
})

it('packaged: ELECTRON_RENDERER_URL cannot move trust to another page', () => {
  vi.stubEnv('ELECTRON_RENDERER_URL', DEV_URL)
  expect(rendererDocument(process.env, true, appPath)).toEqual(BUNDLE)
  expect(admits(windowEvent(`${DEV_URL}/`))).toBe(false)
  expect(admits(windowEvent(INDEX_URL))).toBe(true)
})

it('bundle paths compare decoded, so spellings of the index agree and encoded separators fail', () => {
  const encoded = INDEX_URL.replace('index.html', '%69ndex.html')
  for (const url of [
    INDEX_URL,
    `${INDEX_URL}#settings`,
    `${INDEX_URL}?reload=1`,
    INDEX_URL.replace('/renderer/', '/renderer/x/../'),
    INDEX_URL.replace('/renderer/', '/renderer/x/%2e%2e/'),
    encoded,
  ]) {
    expect(isRendererDocument(url, BUNDLE), url).toBe(true)
  }
  for (const url of [
    INDEX_URL.replace('/out/renderer/index.html', '/out%2Frenderer%2Findex.html'),
    INDEX_URL.replace('/renderer/', '/renderer/%2e%2e/renderer-copy/'),
    INDEX_URL.replace('/renderer/', '/renderer/%252e%252e/'),
    INDEX_URL.replace('index.html', 'index.html%00'),
    INDEX_URL.replace('index.html', 'INDEX.html'),
    `${INDEX_URL}/`,
    INDEX_URL.replace('file:///', 'file://elsewhere/'),
    INDEX_URL.replace('file:', 'http:'),
    'not a url',
  ]) {
    expect(isRendererDocument(url, BUNDLE), url).toBe(false)
  }
})

it('opaque origins are never the renderer document', () => {
  for (const url of ['about:blank', 'data:text/html,hi', 'null', '']) {
    expect(isRendererDocument(url, BUNDLE), url).toBe(false)
    expect(isRendererDocument(url, DEV), url).toBe(false)
  }
  electron.app.isPackaged = false
  vi.stubEnv('ELECTRON_RENDERER_URL', INDEX_URL)
  expect(rendererDocument(process.env, false, appPath)).toBeNull()
  expect(admits(windowEvent(INDEX_URL))).toBe(false)
  vi.stubEnv('ELECTRON_RENDERER_URL', 'data:text/html,hi')
  expect(admits(windowEvent('data:text/html,hi'))).toBe(false)
})

it('dev: admits only the configured origin, not another port, host or scheme', () => {
  devRun()
  expect(rendererDocument(process.env, false, appPath)).toEqual(DEV)
  for (const url of [`${DEV_URL}/`, `${DEV_URL}/index.html`, `${DEV_URL}/#lane`]) {
    expect(admits(windowEvent(url)), url).toBe(true)
  }
  for (const url of [
    'http://localhost:5174/',
    'http://127.0.0.1:5173/',
    'https://localhost:5173/',
    INDEX_URL,
  ]) {
    expect(admits(windowEvent(url)), url).toBe(false)
  }
  expect(admits({ ...windowEvent(`${DEV_URL}/`), senderFrame: { url: `${DEV_URL}/` } })).toBe(false)
})

it('resolves the app path through symlinks, as Node resolves the main bundle', () => {
  const link = join(root, 'linked app')
  symlinkSync(appPath, link)
  electron.app.getAppPath = () => link
  expect(rendererDocument(process.env, true, link)).toEqual(BUNDLE)
  expect(admits(windowEvent(INDEX_URL))).toBe(true)
})

it('a missing app path refuses every call', () => {
  const missing = join(root, 'missing')
  expect(() => rendererDocument(process.env, true, missing)).toThrow()
  electron.app.getAppPath = () => missing
  expect(admits(windowEvent(pathToFileURL(join(missing, 'out/renderer/index.html')).href))).toBe(
    false,
  )
})

it('trusts the same bundle main.ts loads: package main + loadFile path = out/renderer/index.html', async () => {
  // A build-layout change that moves either side would refuse every IPC call; fail here first.
  const { rendererDocument } = await import('./sender-policy')
  const desktop = resolve(import.meta.dirname, '../..')
  const main = (JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8')) as { main: string })
    .main
  const source = readFileSync(join(desktop, 'electron/main.ts'), 'utf8')
  const loaded = /loadFile\(join\(import\.meta\.dirname, '([^']+)'\)\)/.exec(source)?.[1]
  expect(loaded).toBeDefined()
  const bundle = join(realpathSync(desktop), 'out', 'renderer', 'index.html')
  expect(join(realpathSync(desktop), dirname(main), loaded!)).toBe(bundle)
  expect(rendererDocument({}, true, desktop)).toEqual({ kind: 'bundle', path: bundle })
})
