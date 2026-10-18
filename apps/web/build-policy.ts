import { isBuiltin } from 'node:module'

/** Build-time guard only. Never imported by the browser application. */
export function assertBrowserModule(id: string): void {
  const path = id.replaceAll('\\', '/')
  if (
    isBuiltin(id) ||
    path.includes('__vite-browser-external') ||
    /(?:^|\/)apps\/desktop\/(?:electron|src)\//.test(path) ||
    /(?:^|\/)libs\/session-runtime\//.test(path) ||
    /(?:^|\/)node_modules\/(?:electron|electron-store|electron-updater|node-pty)(?:\/|$)/.test(
      path,
    ) ||
    /(?:\.test\.[cm]?[jt]sx?(?:\?|$)|\/__fixtures__\/)/.test(path) ||
    /(?:^|\/)(?:apps|libs)\/[^/]+\/test\//.test(path)
  )
    throw new Error(`Non-browser module in web bundle: ${id}`)
}
