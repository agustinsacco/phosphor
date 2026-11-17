import { isUuid } from '@phosphor/shared/control-api'

/**
 * A worker registration holds one push subscription, bound to one VAPID key, and every
 * Host has its own key: so each Host gets its own registration of the app's worker,
 * at `/push/<clientId>/<hostId>/`. Both ids are UUIDs from Control's session and
 * machine directory, never a value a Host supplied.
 */
export const PUSH_SCOPE_PATH = '/push/'

export function pushScopePath(clientId: string, hostId: string): string | undefined {
  return isUuid(clientId) && isUuid(hostId) ? `${PUSH_SCOPE_PATH}${clientId}/${hostId}/` : undefined
}

export function parsePushScope(scope: string): { clientId: string; hostId: string } | undefined {
  let path: string
  try {
    path = new URL(scope).pathname
  } catch {
    return undefined
  }
  const match = /^\/push\/([^/]+)\/([^/]+)\/$/.exec(path)
  return match && isUuid(match[1]) && isUuid(match[2])
    ? { clientId: match[1], hostId: match[2] }
    : undefined
}

/** A push registration controls no page: its worker only delivers pushes. */
export function isPushScope(scope: string | undefined): boolean {
  try {
    return scope !== undefined && new URL(scope).pathname.startsWith(PUSH_SCOPE_PATH)
  } catch {
    return false
  }
}
