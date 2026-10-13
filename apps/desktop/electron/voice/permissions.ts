import { session } from 'electron'

/**
 * Whether a permission request is granted.
 *
 * Electron grants every request when no handler is set, which is what
 * Phosphor relied on before voice input. That default is kept for
 * everything except media: capture is the microphone only (no camera, no
 * screen), and only for the app's own top-level page. Artifact and preview
 * iframes run model-authored code and never get it.
 */
export function permissionAllowed(
  permission: string,
  details: { isMainFrame?: boolean; mediaTypes?: string[] },
): boolean {
  if (permission !== 'media') return true
  const types = details.mediaTypes ?? []
  return details.isMainFrame === true && types.length > 0 && types.every((t) => t === 'audio')
}

export function installPermissionPolicy(): void {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) =>
    callback(permissionAllowed(permission, details as Parameters<typeof permissionAllowed>[1])),
  )
}
