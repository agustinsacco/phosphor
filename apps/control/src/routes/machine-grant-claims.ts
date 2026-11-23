import {
  GRANT_VERSION,
  GRANT_LIMITS,
  type GrantPayload,
  type GrantClient,
} from '@phosphor/shared/host-grant'

/**
 * Claims for a grant one enrolled machine holds for a sibling. `caps` is always empty
 * and `configure` absent: a Host that does not understand `origin` reads the grant as
 * one that admits nothing. Only verified identity and validated database metadata
 * enter these signed claims.
 */
export function machineGrantClaims(options: {
  origin: string
  kid: string
  ownerId: string
  /** The principal's session id, never a sign-in session. */
  sid: string
  /** The machine the grant is for. */
  targetHostId: string
  /** The enrolled machine that asked, authenticated by its signature. */
  callerHostId: string
  epoch: number
  client: GrantClient
  iat: number
  jti: string
}): GrantPayload {
  return {
    v: GRANT_VERSION,
    iss: options.origin,
    kid: options.kid,
    sub: options.ownerId,
    sid: options.sid,
    hostId: options.targetHostId,
    epoch: options.epoch,
    client: options.client,
    caps: [],
    iat: options.iat,
    exp: options.iat + GRANT_LIMITS.ttlSec,
    jti: options.jti,
    origin: 'machine',
    machine: options.callerHostId,
  }
}
