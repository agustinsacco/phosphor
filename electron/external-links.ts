/**
 * One policy for "this URL leaves the app".
 *
 * `shell.openExternal` will happily launch `file://` or any registered custom
 * scheme, so every URL that reaches it — from `gh` output, from a renderer
 * IPC call, from a link the model wrote — is filtered here first.
 */
export function externalUrl(raw: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return parsed.toString()
}

/**
 * True when a navigation stays inside the app shell — the dev server origin,
 * or the packaged `file://` bundle.
 *
 * The window has exactly one document and no routes, so anything else is a
 * link click that must never replace it: navigating away leaves a shell with
 * no session, no sidebar and no way back short of a reload.
 */
export function isAppNavigation(target: string, current: string): boolean {
  try {
    const to = new URL(target)
    const from = new URL(current)
    // A packaged `file://` document has the opaque origin "null", so origin
    // equality would let any file on disk load into the window. Compare the
    // bundle directory instead.
    if (to.protocol === 'file:' || from.protocol === 'file:') {
      if (to.protocol !== from.protocol) return false
      const dir = from.pathname.slice(0, from.pathname.lastIndexOf('/') + 1)
      return dir !== '' && to.pathname.startsWith(dir)
    }
    return to.origin === from.origin && to.origin !== 'null'
  } catch {
    return false
  }
}
