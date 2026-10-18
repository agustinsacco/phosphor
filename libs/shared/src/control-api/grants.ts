/**
 * Client registration, grant issue and Host revocation bodies. Grants are
 * shaped and signed in ../host-grant; this module only checks the reply that
 * carries one. Parsers keep known fields only.
 */

import { GRANT_LIMITS, GRANT_PREFIX } from '../host-grant'
import {
  fail,
  isCount,
  isEndpoint,
  isIso,
  isRecord,
  isUuid,
  normalizeLabel,
  ok,
  optional,
  type Parsed,
} from './fields'
import { isPublicKey } from './signing'
import type {
  ClientRegisterRequest,
  ClientRegisterResponse,
  GrantIssueRequest,
  GrantIssueResponse,
  HostRevocations,
} from './types'

export function parseClientRegisterRequest(value: unknown): Parsed<ClientRegisterRequest> {
  const label = isRecord(value) ? normalizeLabel(value.label) : null
  return label === null ? fail('label') : ok({ label })
}
export function parseClientRegisterResponse(value: unknown): Parsed<ClientRegisterResponse> {
  if (!isRecord(value) || !isRecord(value.client) || !isUuid(value.client.id)) return fail('client')
  const label = normalizeLabel(value.client.label)
  if (label === null || label !== value.client.label) return fail('label')
  return ok({ client: { id: value.client.id, label } })
}
export function parseGrantIssueRequest(value: unknown): Parsed<GrantIssueRequest> {
  if (!isRecord(value) || !isUuid(value.hostId) || !isUuid(value.clientId)) return fail('ids')
  return ok({ hostId: value.hostId, clientId: value.clientId })
}
export function parseGrantIssueResponse(value: unknown): Parsed<GrantIssueResponse> {
  if (!isRecord(value) || !isRecord(value.host)) return fail('body')
  if (
    typeof value.grant !== 'string' ||
    value.grant.length > GRANT_LIMITS.tokenChars ||
    !value.grant.startsWith(GRANT_PREFIX) ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/.test(value.grant.slice(GRANT_PREFIX.length))
  )
    return fail('grant')
  if (!isIso(value.expiresAt)) return fail('expiresAt')
  if (!isUuid(value.host.id) || !isPublicKey(value.host.publicKey)) return fail('host')
  const endpoint = optional(value.host.endpoint, isEndpoint)
  if (endpoint === undefined) return fail('endpoint')
  return ok({
    grant: value.grant,
    expiresAt: value.expiresAt,
    host: { id: value.host.id, endpoint, publicKey: value.host.publicKey },
  })
}
export function parseRevoked(value: unknown): HostRevocations['revoked'] | null {
  if (!isRecord(value)) return null
  const lists: string[][] = []
  for (const list of [value.sessions, value.clients]) {
    if (!Array.isArray(list) || list.length > GRANT_LIMITS.revocations) return null
    const ids: string[] = []
    for (const id of list) {
      if (!isUuid(id)) return null
      ids.push(id)
    }
    lists.push(ids)
  }
  const [sessions, clients] = lists
  return sessions && clients ? { sessions, clients } : null
}
export function parseHostRevocations(value: unknown): Parsed<HostRevocations> {
  if (!isRecord(value) || !isUuid(value.ownerId)) return fail('ownerId')
  if (!isCount(value.epoch, 2147483647) || value.epoch < 1) return fail('epoch')
  const revoked = parseRevoked(value.revoked)
  return revoked ? ok({ ownerId: value.ownerId, epoch: value.epoch, revoked }) : fail('revoked')
}
