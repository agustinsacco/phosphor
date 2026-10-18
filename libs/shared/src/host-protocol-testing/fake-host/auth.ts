import { CONTROL_LIMITS } from '../../control-api'
import {
  checkGrantClaims,
  encodeBase64url,
  grantUtf8,
  splitGrant,
  type GrantPayload,
} from '../../host-grant'
import { HOST_PROTOCOL_VERSION, helloProofMessage, type ClientFrame } from '../../host-protocol'
import type { HostCapability } from '../../remote-host'
import { send } from './delivery'
import type { Connection, FakeHostState } from './state'
import { publish, summary } from './streams'

type AuthFrame = Extract<ClientFrame, { type: 'auth' }>

/** A capability counts only when both the connection's grant and the Host announce it. */
export function authorized(state: FakeHostState, c: Connection, cap: HostCapability): boolean {
  return c.grant !== null && c.grant.caps.includes(cap) && state.caps.includes(cap)
}

/** First auth or renewal on one socket. Every refusal closes the socket with its exact code. */
export function authenticate(state: FakeHostState, c: Connection, f: AuthFrame) {
  const grant = verifiedGrant(state, c, f.grant)
  if (!grant || !admitIdentity(state, c, f, grant)) return
  const renewal = c.grant !== null
  c.grant = grant
  clearTimeout(c.authTimer)
  scheduleExpiry(c, grant)
  if (renewal) {
    if (!authorized(state, c, 'sessions.read')) {
      c.subscriptions.clear()
      c.stale.clear()
    }
    send(state, c, {
      type: 'auth-renewed',
      grantExpiresAt: new Date(grant.exp * 1000).toISOString(),
    })
  } else {
    ready(state, c, grant, f.challenge ?? '')
    reconnectControllers(state, grant)
  }
}

/** Injected verification (or verifyGrant), then claims: 4401 for signature and time, else 4403. */
export function verifiedGrant(
  state: FakeHostState,
  c: Connection,
  token: string,
): GrantPayload | null {
  const options = state.options
  let grant: GrantPayload | null = null
  if (options.verifyGrant) grant = options.verifyGrant(token)
  else {
    const p = splitGrant(token)
    if (p.ok && options.verify(p.value.payloadBytes, p.value.signature, p.value.payload.kid))
      grant = p.value.payload
  }
  if (!grant) {
    c.socket.close(4401, 'Invalid grant')
    return null
  }
  const failure = checkGrantClaims(
    grant,
    {
      ...options.expectations,
      revokedSessions: state.revokedSessions,
      revokedClients: state.revokedClients,
    },
    Date.now() / 1000,
    CONTROL_LIMITS.signatureSkewSec,
  )
  if (failure) {
    c.socket.close(
      failure === 'expired' || failure === 'not-yet-valid' || failure === 'lifetime' ? 4401 : 4403,
      'Grant refused',
    )
    return null
  }
  return grant
}

/** A renewal keeps owner and client and sends no challenge; a first auth needs one and a slot. */
export function admitIdentity(
  state: FakeHostState,
  c: Connection,
  f: AuthFrame,
  grant: GrantPayload,
): boolean {
  if (c.grant) {
    if (
      c.grant.sub !== grant.sub ||
      c.grant.client.id !== grant.client.id ||
      f.challenge !== undefined
    ) {
      c.socket.close(4403, 'Identity changed')
      return false
    }
    return true
  }
  if (!f.challenge) {
    c.socket.close(4401, 'Challenge required')
    return false
  }
  if (
    [...state.connections].filter((x) => x.grant?.client.id === grant.client.id).length >=
    state.limits.connectionsPerClient
  ) {
    c.socket.close(4429, 'Too many connections')
    return false
  }
  return true
}

/** The socket closes once the grant has expired, allowing the signature skew. */
export function scheduleExpiry(c: Connection, grant: GrantPayload) {
  clearTimeout(c.expiryTimer)
  c.expiryTimer = setTimeout(
    () => c.socket.close(4401, 'Grant expired'),
    Math.max(0, (grant.exp + CONTROL_LIMITS.signatureSkewSec) * 1000 - Date.now()),
  )
}

/** Proves the Host with the injected signer over the hello proof message. */
export function ready(state: FakeHostState, c: Connection, grant: GrantPayload, challenge: string) {
  const { options, caps } = state
  send(state, c, {
    type: 'ready',
    protocolVersion: HOST_PROTOCOL_VERSION,
    hello: {
      hostId: options.expectations.hostId,
      hostVersion: '0.0.0',
      protocolVersion: 1,
      runtimeEpoch: state.epoch,
      capabilities: [...caps],
    },
    proof: encodeBase64url(
      options.sign(
        grantUtf8(helloProofMessage(options.expectations.hostId, state.epoch, challenge)),
      ),
    ),
    connectionId: options.epoch(),
    grantExpiresAt: new Date(grant.exp * 1000).toISOString(),
    client: grant.client,
    capabilities: grant.caps.filter((cap) => caps.includes(cap)),
  })
}

/** A returning controller is marked connected again; its fence does not change. */
export function reconnectControllers(state: FakeHostState, grant: GrantPayload) {
  for (const l of state.lanes.values()) {
    const controller = l.summary.control.controller
    if (controller?.clientId === grant.client.id && !controller.connected) {
      l.summary = {
        ...l.summary,
        control: { ...l.summary.control, controller: { ...controller, connected: true } },
      }
      publish(state, send, l, { kind: 'control', control: l.summary.control })
      summary(state, send, l)
    }
  }
}
