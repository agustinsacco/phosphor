/** The ready frame: the Host's enrolled hello, its proof and the connection's capabilities. */
import { isIsoTime, isUuid } from '../control-api'
import {
  HOST_CAPABILITIES,
  HOST_PROTOCOL_VERSION,
  validateHostHello,
  type HostCapability,
} from '../remote-host'
import type { HostFrame } from './frames'
import { hex, label, member, record, text } from './primitives'

/** Known capabilities only, each once; stricter than validateHostHello, which drops unknowns. */
function capabilities(v: unknown): v is HostCapability[] {
  return (
    Array.isArray(v) &&
    v.length <= HOST_CAPABILITIES.length &&
    v.every((x) => member(x, HOST_CAPABILITIES)) &&
    new Set(v).size === v.length
  )
}

/**
 * The proof is a 64-byte signature as 86 unpadded base64url characters; only
 * the top two bits of the last one are used, so it is A, Q, g or w. The
 * connection's capabilities are a subset of the hello's.
 */
export function parseReadyFrame(
  v: Record<string, unknown>,
): Extract<HostFrame, { type: 'ready' }> | null {
  if (
    !record(v.hello) ||
    !isUuid(v.hello.hostId) ||
    !hex(v.hello.runtimeEpoch) ||
    !capabilities(v.hello.capabilities)
  )
    return null
  const h = validateHostHello(v.hello, v.hello.hostId)
  if (
    !h.ok ||
    v.protocolVersion !== HOST_PROTOCOL_VERSION ||
    !text(v.proof, 86, 86) ||
    !/^[A-Za-z0-9_-]{85}[AQgw]$/.test(v.proof) ||
    !hex(v.connectionId) ||
    !isIsoTime(v.grantExpiresAt) ||
    !record(v.client) ||
    !isUuid(v.client.id) ||
    !label(v.client.label) ||
    !capabilities(v.capabilities) ||
    !v.capabilities.every((c) => h.hello.capabilities.includes(c))
  )
    return null
  return {
    type: 'ready',
    protocolVersion: HOST_PROTOCOL_VERSION,
    hello: h.hello,
    proof: v.proof,
    connectionId: v.connectionId,
    grantExpiresAt: v.grantExpiresAt,
    client: { id: v.client.id, label: v.client.label },
    capabilities: v.capabilities,
  }
}
