/** Host API constants: the port, routes, upper bounds, close codes and hello proof text. */
import { HOST_PROTOCOL_VERSION } from '../remote-host'

export { HOST_PROTOCOL_VERSION }

/** Loopback port the Host API listens on; `tailscale serve` exposes the same HTTPS port. */
export const HOST_API_PORT = 47615

export const HOST_API_ROUTES = {
  /** GET, unauthenticated: hello plus a proof over the caller's challenge. */
  hello: '/v1/hello',
  /** GET, WebSocket upgrade. Everything else is a frame on this socket. */
  stream: '/v1/stream',
} as const

/** Upper bounds. A brief may lower these, never raise them. */
export const HOST_LIMITS = {
  /** Client to Host, UTF-8 bytes. Prompts with images need the room. */
  inboundFrameBytes: 8 * 1024 * 1024,
  /** Host to client, UTF-8 bytes. Oversize subscriptions fail with too-large. */
  outboundFrameBytes: 16 * 1024 * 1024,
  /** The first frame must be `auth` within this. */
  authTimeoutMs: 10_000,
  /** A grant lives at most this long (`exp - iat`). */
  grantTtlSec: 300,
  /** Clients renew this long before `grantExpiresAt`. */
  renewBeforeSec: 60,
  pingIntervalMs: 20_000,
  /** No frame from the client for this long closes the socket. */
  idleCloseMs: 60_000,
  subscriptionsPerConnection: 64,
  connectionsPerClient: 4,
  /** Commands admitted but not yet answered, per connection. */
  pendingCommandsPerConnection: 32,
  /** The architecture's unknown-receipts amendment: no pi answer means uncertainty. */
  commandAnswerMs: 30_000,
  /** Per lane: events kept for replay, by count and by bytes. */
  replayEvents: 2000,
  replayBytes: 8 * 1024 * 1024,
  /** Per connection: queued outbound bytes before a lane is reset to a snapshot. */
  sendQueueBytes: 32 * 1024 * 1024,
  /** Events in a snapshot's `pending` (the turn in flight). */
  pendingEvents: 4000,
  uiStatusKeys: 64,
  uiWidgetKeys: 32,
  receiptsKept: 10_000,
  receiptTtlMs: 24 * 60 * 60 * 1000,
  /** A receipt's stored `data`, UTF-8 bytes of its JSON. Larger data is dropped, not truncated. */
  receiptDataBytes: 256 * 1024,
  lanesPerHost: 1000,
  repositoriesPerHost: 64,
  /** Attention events kept per Host for replay to a returning client. */
  attentionReplay: 200,
  /** Labels a client chooses: lane titles, client labels. */
  labelChars: 80,
  /** Free-text error messages forwarded to clients. */
  messageChars: 2000,
  /** Frame ids, subscription ids and call ids. */
  idChars: 64,
} as const

/** WebSocket close codes. 1001 is the standard "going away" (Host stopping). */
export const HOST_CLOSE = {
  goingAway: 1001,
  badFrame: 4400,
  unauthenticated: 4401,
  forbidden: 4403,
  unsupportedProtocol: 4409,
  tooMany: 4429,
} as const
export type HostCloseCode = (typeof HOST_CLOSE)[keyof typeof HOST_CLOSE]

/**
 * What the Host signs to prove it is the enrolled machine. The client sends a
 * fresh 32-byte challenge (64 lowercase hex) and verifies the signature with
 * the Host public key the grant broker returned with its grant.
 */
export function helloProofMessage(hostId: string, runtimeEpoch: string, challenge: string): string {
  return `phosphor-host-hello/v1\n${hostId}\n${runtimeEpoch}\n${challenge}`
}
