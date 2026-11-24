// Frozen copy of libs/shared/src/host-protocol/host-ready.ts at 684cb3478 (the release before the agent-control
// contracts). Only import paths differ. Never edit: compatibility tests run new
// frames through it to prove a previous-release reader accepts them.
/** The ready frame: the Host's enrolled hello, its proof and the connection's capabilities. */
import { isIsoTime, isUuid } from '../../control-api'
import {
  HOST_CAPABILITIES,
  HOST_PROTOCOL_VERSION,
  validateHostHello,
  type HostCapability,
} from '../../remote-host'
import type { HostFrame } from '../../host-protocol/frames'
import { hex, label, member, record, text } from '../../host-protocol/primitives'
import { isP256PublicKey } from '../../host-protocol-web-push'

/** Known capabilities only, each once; stricter than validateHostHello, which drops unknowns. */
export function capabilities(v: unknown): v is HostCapability[] {
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
    (v.settings !== undefined && typeof v.settings !== 'boolean') ||
    (v.machineShell !== undefined && typeof v.machineShell !== 'boolean') ||
    (v.laneMarks !== undefined && typeof v.laneMarks !== 'boolean') ||
    (v.laneArchive !== undefined && typeof v.laneArchive !== 'boolean') ||
    (v.laneTransfer !== undefined && typeof v.laneTransfer !== 'boolean') ||
    (v.fileBytes !== undefined && typeof v.fileBytes !== 'boolean') ||
    (v.prStatus !== undefined && typeof v.prStatus !== 'boolean') ||
    (v.webPushKey !== undefined && !isP256PublicKey(v.webPushKey)) ||
    (v.prTracking !== undefined && typeof v.prTracking !== 'boolean') ||
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
    ...(v.settings !== undefined ? { settings: v.settings as boolean } : {}),
    ...(v.machineShell !== undefined ? { machineShell: v.machineShell as boolean } : {}),
    ...(v.laneMarks !== undefined ? { laneMarks: v.laneMarks as boolean } : {}),
    ...(v.laneArchive !== undefined ? { laneArchive: v.laneArchive as boolean } : {}),
    ...(v.laneTransfer !== undefined ? { laneTransfer: v.laneTransfer as boolean } : {}),
    ...(v.fileBytes !== undefined ? { fileBytes: v.fileBytes as boolean } : {}),
    ...(v.prStatus !== undefined ? { prStatus: v.prStatus as boolean } : {}),
    ...(v.webPushKey !== undefined ? { webPushKey: v.webPushKey } : {}),
    ...(v.prTracking !== undefined ? { prTracking: v.prTracking as boolean } : {}),
  }
}
