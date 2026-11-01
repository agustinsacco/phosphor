/**
 * Host protocol v1: the only language Desktop (and later the PWA) speaks to a
 * Host, over one WebSocket per client per Host, reached through Tailscale.
 *
 * The machine that runs a lane is its single ordering point. Every mutation is
 * a `command` with a client request id, admitted against the lane's control
 * fence and answered by exactly one durable receipt. Every change a viewer can
 * see arrives as an ordered `event` in that lane's stream, so all viewers flip
 * state at the same point (requirement R7).
 *
 * Pure module: no Node or DOM imports. Living contract: docs/remote-access.md
 * ("Host protocol"). This is the public entry; the declarations and parsers
 * live in ./host-protocol/, and nothing there imports this file.
 */
export type { LaneReceipt } from './lane-receipt'
export {
  HOST_API_PORT,
  HOST_API_ROUTES,
  HOST_CLOSE,
  HOST_LIMITS,
  HOST_PROTOCOL_VERSION,
  helloProofMessage,
  type HostCloseCode,
} from './host-protocol/constants'
export type {
  AttentionEvent,
  AttentionKind,
  LaneActivity,
  LaneControl,
  LaneController,
  LaneEvent,
  LanePiPush,
  LaneSnapshot,
  LaneSummary,
  RepositorySummary,
  StreamCursor,
} from './host-protocol/lanes'
export {
  CAPABILITY_FOR,
  HOST_CALL_METHODS,
  LANE_CREATE_PHASES,
  LANE_PI_OPS,
  UNFENCED_OPS,
  isLanePiOp,
  type CallError,
  type CallErrorCode,
  type FailureCode,
  type HostCallMethod,
  type LaneOp,
  type LaneCreatePhase,
  type LaneOpType,
  type LanePiOp,
  type LanePiOpType,
  type Receipt,
  type RejectCode,
} from './host-protocol/operations'
export type { ClientFrame, ClientFrameParse, FrameSocket, HostFrame } from './host-protocol/frames'
export { isLaneBranchName, utf8Length } from './host-protocol/primitives'
export { parseClientFrame } from './host-protocol/client'
export { parseHostFrame } from './host-protocol/host'
