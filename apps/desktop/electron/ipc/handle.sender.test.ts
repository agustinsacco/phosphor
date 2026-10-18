import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, expect, it, vi, type Mock } from 'vitest'
import type { IpcInvokeChannel } from '@shared/ipc'

interface FakeFrame {
  url: string
}
interface FakeContents {
  id: number
  mainFrame: FakeFrame
  isDestroyed: () => boolean
}
interface FakeWindow {
  webContents: FakeContents
  isDestroyed: () => boolean
}

const electron = vi.hoisted(() => ({
  handle: vi.fn(),
  owners: new Map<FakeContents, FakeWindow>(),
  app: { isPackaged: true, getAppPath: (): string => '' },
}))
vi.mock('electron', () => ({
  ipcMain: { handle: electron.handle },
  app: electron.app,
  BrowserWindow: {
    fromWebContents: (contents: FakeContents) => electron.owners.get(contents) ?? null,
  },
}))
import { handle, setRemoteReadRouter } from './handle'

const appPath = mkdtempSync(join(tmpdir(), 'phosphor-sender-'))
electron.app.getAppPath = () => appPath
/** The document main.ts loads outside dev: the bundle's index, found through symlinks. */
const INDEX_URL = pathToFileURL(join(realpathSync(appPath), 'out', 'renderer', 'index.html')).href
const DEV_URL = 'http://localhost:5173'

afterAll(() => rmSync(appPath, { recursive: true, force: true }))
afterEach(() => {
  setRemoteReadRouter(() => null)
  electron.app.isPackaged = true
  vi.unstubAllEnvs()
})

/** The invoke event a live window sends from its own main frame while showing `url`. */
function windowEvent(
  id: number,
  url: string,
): { sender: FakeContents; senderFrame: FakeFrame | null } {
  const mainFrame: FakeFrame = { url }
  const sender: FakeContents = { id, mainFrame, isDestroyed: () => false }
  electron.owners.set(sender, { webContents: sender, isDestroyed: () => false })
  return { sender, senderFrame: mainFrame }
}

/** The wrapper handle() registers with ipcMain for this channel. */
function registered(channel: IpcInvokeChannel, local: Mock) {
  handle(channel, local)
  const wrapped: unknown = electron.handle.mock.calls.at(-1)?.[1]
  if (typeof wrapped !== 'function') throw new Error('Missing handler')
  return (event: unknown, ...args: unknown[]): unknown => wrapped(event, ...args)
}

/** What the renderer's invoke settles with: the value, or the thrown or rejected error. */
async function outcome(call: () => unknown): Promise<unknown> {
  try {
    return await call()
  } catch (error) {
    return error
  }
}

it('characterize: an admitted local call keeps the event, argument order and result', async () => {
  const event = windowEvent(3, INDEX_URL)
  const local = vi.fn((_event: unknown, ...args: unknown[]) => ['local', ...args])
  const write = registered('fs:writeFile', local)
  expect(write(event, '/local/a.ts', 'text', null)).toEqual(['local', '/local/a.ts', 'text', null])
  expect(local).toHaveBeenCalledWith(event, '/local/a.ts', 'text', null)
  const commit = registered(
    'git:commitAll',
    vi.fn(async () => ({ sha: 'abc123' })),
  )
  expect(await commit(event, '/local/repository', 'message')).toEqual({ sha: 'abc123' })
})

it('characterize: an admitted local call surfaces handler errors and rejections unchanged', async () => {
  const event = windowEvent(4, INDEX_URL)
  const thrown = new Error('disk full')
  const rejected = new Error('permission denied')
  const sync = registered(
    'fs:readFile',
    vi.fn(() => {
      throw thrown
    }),
  )
  expect(await outcome(() => sync(event, '/local/a.ts'))).toBe(thrown)
  const async = registered(
    'fs:readFile',
    vi.fn(async () => Promise.reject(rejected)),
  )
  expect(await outcome(() => async(event, '/local/a.ts'))).toBe(rejected)
})

it('characterize: an admitted remote call gets the router answer with the window id and arguments', async () => {
  const event = windowEvent(5, INDEX_URL)
  const local = vi.fn()
  const router = vi.fn((_windowId: number, channel: IpcInvokeChannel, args: unknown[]) =>
    channel === 'fs:listFiles' && args[0] === 'host:machine/repository'
      ? { result: Promise.resolve(['a.ts']) }
      : null,
  )
  setRemoteReadRouter(router)
  const list = registered('fs:listFiles', local)
  expect(await list(event, 'host:machine/repository')).toEqual(['a.ts'])
  expect(router).toHaveBeenCalledWith(5, 'fs:listFiles', ['host:machine/repository'])
  expect(local).not.toHaveBeenCalled()
})

it('characterize: router errors reach the caller and a declined route runs locally', async () => {
  const event = windowEvent(6, INDEX_URL)
  const offline = new Error('host offline')
  const local = vi.fn(() => ['local.ts'])
  setRemoteReadRouter((_windowId, _channel, args) => {
    if (args[0] === 'host:offline/repository') throw offline
    return null
  })
  const list = registered('fs:listFiles', local)
  expect(await outcome(() => list(event, 'host:offline/repository'))).toBe(offline)
  expect(local).not.toHaveBeenCalled()
  expect(await list(event, '/local/repository')).toEqual(['local.ts'])
  expect(local).toHaveBeenCalledWith(event, '/local/repository')
})

it('characterize: an unpackaged run admits its configured dev server page', async () => {
  electron.app.isPackaged = false
  vi.stubEnv('ELECTRON_RENDERER_URL', DEV_URL)
  const event = windowEvent(7, `${DEV_URL}/`)
  const local = vi.fn(() => 'local')
  const routed = vi.fn(() => ({ result: Promise.resolve('routed') }))
  expect(registered('fs:readFile', local)(event, '/local/a.ts')).toBe('local')
  setRemoteReadRouter(routed)
  expect(await registered('fs:listFiles', vi.fn())(event, 'host:machine/repository')).toBe('routed')
  expect(routed).toHaveBeenCalledWith(7, 'fs:listFiles', ['host:machine/repository'])
})

/** The fixed text every refused sender gets; it names no frame, URL or window. */
const REFUSED = 'Refused: this call did not come from the Phosphor window.'

/** Untrusted senders while the bundle is the renderer document. */
const PACKAGED_REFUSALS: [string, () => unknown][] = [
  [
    'no window owns the contents',
    () => {
      const event = windowEvent(11, INDEX_URL)
      electron.owners.delete(event.sender)
      return event
    },
  ],
  [
    'destroyed window',
    () => {
      const event = windowEvent(12, INDEX_URL)
      const window = electron.owners.get(event.sender)
      if (window) window.isDestroyed = () => true
      return event
    },
  ],
  [
    'destroyed contents',
    () => {
      const event = windowEvent(13, INDEX_URL)
      event.sender.isDestroyed = () => true
      return event
    },
  ],
  [
    'contents hosted in a window that are not its own',
    () => {
      const event = windowEvent(14, INDEX_URL)
      const window = windowEvent(15, INDEX_URL).sender
      electron.owners.set(event.sender, { webContents: window, isDestroyed: () => false })
      return event
    },
  ],
  [
    'subframe showing the index',
    () => ({ ...windowEvent(16, INDEX_URL), senderFrame: { url: INDEX_URL } }),
  ],
  ['frame already gone', () => ({ ...windowEvent(17, INDEX_URL), senderFrame: null })],
  ['sibling file in the bundle', () => windowEvent(18, new URL('other.html', INDEX_URL).href)],
  ['file outside the bundle', () => windowEvent(19, pathToFileURL('/tmp/index.html').href)],
  ['opaque-origin page', () => windowEvent(20, 'about:blank')],
  ['web page', () => windowEvent(21, 'https://example.com/index.html')],
  ['missing event', () => undefined],
  ['frameless event', () => ({})],
]

/** Untrusted senders while an unpackaged run follows the dev server. */
const DEV_REFUSALS: [string, () => unknown][] = [
  ['dev server on another port', () => windowEvent(31, 'http://localhost:5174/')],
  ['dev server on another host', () => windowEvent(32, 'http://127.0.0.1:5173/')],
  ['bundle index in a dev run', () => windowEvent(33, INDEX_URL)],
  [
    'subframe on the dev origin',
    () => ({ ...windowEvent(34, `${DEV_URL}/`), senderFrame: { url: `${DEV_URL}/` } }),
  ],
]

/** Asserts neither route runs: a router that would answer, then one that declines to local. */
async function expectRefusedBeforeRouting(name: string, makeEvent: () => unknown) {
  const routed = vi.fn(() => ({ result: Promise.resolve('routed') }))
  setRemoteReadRouter(routed)
  const remoteLocal = vi.fn(() => 'local')
  const remote = await outcome(() =>
    registered('fs:listFiles', remoteLocal)(makeEvent(), 'host:m/r'),
  )
  expect(remote instanceof Error ? remote.message : remote, name).toBe(REFUSED)
  expect(routed, name).not.toHaveBeenCalled()
  expect(remoteLocal, name).not.toHaveBeenCalled()
  const declined = vi.fn(() => null)
  setRemoteReadRouter(declined)
  const local = vi.fn(() => 'local')
  const write = await outcome(() =>
    registered('fs:writeFile', local)(makeEvent(), '/local/a.ts', 'x', null),
  )
  expect(write instanceof Error ? write.message : write, name).toBe(REFUSED)
  expect(declined, name).not.toHaveBeenCalled()
  expect(local, name).not.toHaveBeenCalled()
}

it('regression: an untrusted packaged sender reaches neither the router nor a local handler', async () => {
  for (const [name, makeEvent] of PACKAGED_REFUSALS)
    await expectRefusedBeforeRouting(name, makeEvent)
})

it('regression: an unpackaged run refuses every page but its configured dev server', async () => {
  electron.app.isPackaged = false
  vi.stubEnv('ELECTRON_RENDERER_URL', DEV_URL)
  for (const [name, makeEvent] of DEV_REFUSALS) await expectRefusedBeforeRouting(name, makeEvent)
})
