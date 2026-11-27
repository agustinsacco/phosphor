/**
 * Agent control's shared contracts: catalog types, the op channel between a
 * lane's `phosphor` tool and its owner, and the agent policy. The wire envelope
 * is `./host-protocol-ops`. Pure module. Living contract: docs/agent-control.md.
 */
export { OP_CLASSES, OP_SCOPES, OP_TIERS } from './ops/types'
export type { OpArgs, OpClass, OpContext, OpScope, OpSpec, OpTier } from './ops/types'
export {
  CONFIRM_TITLE_PREFIX,
  DIRECTIVES_BASE_ENV,
  HEADROOM_SOCKET_ENV,
  LANE_CONTROLS_SLOT,
  LANE_LIVENESS_OP,
  LANE_WAIT_DEADLINE_MS,
  LANE_WAIT_TIMEOUT,
  OP_CHANNEL_LIMITS,
  OP_MARKER_ENV,
  OP_MARKER_VALUE,
  OP_METHOD,
  OP_REPLY_CODES,
  OP_TITLE,
  OP_TOOL_NAME,
  noOwnerReply,
  parseOpChannelRequest,
} from './ops/channel'
export type {
  LaneEffect,
  LaneLivenessMessage,
  OpChannelRequest,
  OpFacts,
  OpReplyEnvelope,
  OpRequestEnvelope,
  SwarmFacts,
} from './ops/channel'
export { AGENT_POLICY_DEFAULT, AGENT_POLICY_LIMITS, parseAgentPolicy } from './ops/policy'
export type {
  AgentOpRow,
  AgentPolicy,
  AuditDecision,
  ConfirmInfo,
  PolicyDecision,
} from './ops/policy'
