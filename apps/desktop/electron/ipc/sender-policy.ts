import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'
import { devRendererUrl } from '../dev-renderer-url'

/** Fixed text for every refused sender; it names no frame, URL or window. */
export const UNTRUSTED_SENDER = 'Refused: this call did not come from the Phosphor window.'

/** The one document allowed to call IPC: the dev server's origin, or the bundled index file. */
export type RendererDocument =
  { kind: 'dev-server'; origin: string } | { kind: 'bundle'; path: string }

let resolvedApp: { appPath: string; realPath: string } | undefined
function realAppPath(appPath: string): string {
  if (resolvedApp?.appPath !== appPath) resolvedApp = { appPath, realPath: realpathSync(appPath) }
  return resolvedApp.realPath
}

/**
 * The document main.ts loads, or `null` when no page can be trusted.
 *
 * An unpackaged run with ELECTRON_RENDERER_URL loads that dev server. Every
 * other run loads `out/renderer/index.html` beside the main bundle, whose path
 * Node resolves through symlinks, so the app path is resolved the same way.
 * Throws when the app path does not exist.
 */
export function rendererDocument(
  env: NodeJS.ProcessEnv,
  isPackaged: boolean,
  appPath: string,
): RendererDocument | null {
  const devUrl = devRendererUrl(env, isPackaged)
  if (devUrl === undefined) {
    return { kind: 'bundle', path: join(realAppPath(appPath), 'out', 'renderer', 'index.html') }
  }
  const origin = webOrigin(devUrl)
  return origin === null ? null : { kind: 'dev-server', origin }
}

/** The http(s) origin of `url`; `null` for an opaque origin or an unparsable URL. */
function webOrigin(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null
  } catch {
    return null
  }
}

/**
 * True when a frame at `url` shows the renderer document.
 *
 * A dev run compares origins. A bundle compares decoded file paths: every
 * `file:` page shares one opaque origin, so a sibling file must not pass, and
 * Chromium and Node may percent-encode the same path differently. Fragment and
 * query do not name another file; an encoded separator is refused.
 */
export function isRendererDocument(url: string, document: RendererDocument): boolean {
  if (document.kind === 'dev-server') return webOrigin(url) === document.origin
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'file:' && fileURLToPath(parsed) === document.path
  } catch {
    return false
  }
}

/** The parts of an invoke event that admission reads. */
export type InvokeSender = Pick<Electron.IpcMainInvokeEvent, 'sender' | 'senderFrame'>

/**
 * Throw unless the call came from a live window's own main frame while that
 * frame shows the renderer document. It runs before any routing, so a refused
 * call has no effect. Navigation policy (external-links.ts) only decides what
 * the window may load; this checks the caller of each call.
 */
export function admitSender(event: InvokeSender): void {
  if (!isAdmitted(event)) throw new Error(UNTRUSTED_SENDER)
}

function isAdmitted(event: InvokeSender): boolean {
  try {
    const contents = event.sender
    const window = BrowserWindow.fromWebContents(contents)
    if (window === null || window.isDestroyed() || contents.isDestroyed()) return false
    if (window.webContents !== contents) return false
    const frame = event.senderFrame
    if (frame === null || frame !== contents.mainFrame) return false
    const document = rendererDocument(process.env, app.isPackaged, app.getAppPath())
    return document !== null && isRendererDocument(frame.url, document)
  } catch {
    // A malformed event, a destroyed object or a missing bundle: refuse.
    return false
  }
}
