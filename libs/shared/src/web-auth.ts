import { isUuid, type Parsed, parseClientRegisterResponse } from './control-api'

export const WEB_AUTH_ROUTES = {
  start: '/api/auth/start',
  callback: '/api/auth/callback',
  session: '/api/auth/session',
  signout: '/api/auth/signout',
  clients: '/api/v1/clients',
} as const
export const WEB_CSRF_HEADER = 'x-phosphor-csrf'
export interface WebSessionResponse {
  user: { id: string; login: string | null }
  clientId: string
  csrfToken: string
}
export interface WebSignoutResponse {
  signedOut: true
  remoteCleanup: 'complete' | 'pending'
}
export interface WebClient {
  id: string
  label: string
  kind: 'desktop' | 'web'
  revokedAt: string | null
}
export interface WebClientsResponse {
  clients: WebClient[]
}
export function parseWebClientsResponse(value: unknown): Parsed<WebClientsResponse> {
  if (
    !value ||
    typeof value !== 'object' ||
    !('clients' in value) ||
    !Array.isArray(value.clients) ||
    value.clients.length > 100
  )
    return { ok: false, reason: 'Invalid clients' }
  const clients: WebClient[] = []
  for (const row of value.clients) {
    const client = parseClientRegisterResponse({ client: row })
    if (
      !client.ok ||
      !isUuid(row.id) ||
      !['desktop', 'web'].includes(row.kind) ||
      (row.revokedAt !== null &&
        (typeof row.revokedAt !== 'string' ||
          !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(row.revokedAt) ||
          !Number.isFinite(Date.parse(row.revokedAt))))
    )
      return { ok: false, reason: 'Invalid client' }
    clients.push({ ...client.value.client, kind: row.kind, revokedAt: row.revokedAt })
  }
  if (new Set(clients.map((c) => c.id)).size !== clients.length)
    return { ok: false, reason: 'Duplicate clients' }
  return { ok: true, value: { clients } }
}
