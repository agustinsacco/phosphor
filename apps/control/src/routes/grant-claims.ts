import {
  GRANT_VERSION,
  GRANT_LIMITS,
  type GrantPayload,
  type GrantClient,
} from '@phosphor/shared/host-grant'
import { LEGACY_HOST_CAPABILITIES } from '@phosphor/shared/remote-host'

/** Only verified identity and validated database metadata enter these signed claims. */
export function grantClaims(options: {
  origin: string
  kid: string
  userId: string
  sid: string
  hostId: string
  epoch: number
  client: GrantClient
  configure?: true
  iat: number
  jti: string
}): GrantPayload {
  return {
    v: GRANT_VERSION,
    iss: options.origin,
    kid: options.kid,
    sub: options.userId,
    sid: options.sid,
    hostId: options.hostId,
    epoch: options.epoch,
    client: options.client,
    caps: LEGACY_HOST_CAPABILITIES,
    ...(options.configure === true ? { configure: true as const } : {}),
    iat: options.iat,
    exp: options.iat + GRANT_LIMITS.ttlSec,
    jti: options.jti,
  }
}
