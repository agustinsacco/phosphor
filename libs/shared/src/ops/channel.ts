/**
 * The op channel: how the `phosphor` tool inside a pi lane reaches the process
 * that owns the lane. The tool sends an RPC `editor` request titled `OP_TITLE`
 * whose prefill is an `OpChannelRequest` as JSON; the owner answers with an
 * `OpReplyEnvelope` as the editor's value. The owner must answer every request
 * id, because pi keeps an unanswered editor pending even after an abort. When
 * nothing listens, the RPC client answers `noOwnerReply` at once.
 *
 * Skill bodies passed with `--skill` are advertised, not inlined, so nothing
 * here depends on the skill's text. Reached through `../ops`.
 */
import {
  OPS_DENY_CODES,
  OPS_LIMITS,
  isOpName,
  parseOpsConfirmRef,
  type OpApplies,
  type OpsConfirmRef,
  type OpsDenyCode,
} from '../host-protocol-ops'
import { integer, record, text, utf8Length } from '../host-protocol/primitives'

export const OP_TITLE = 'phosphor-op/v1'
export const OP_METHOD = 'editor'
/** Set in a lane's environment when its owner listens on the channel. */
export const OP_MARKER_ENV = 'PHOSPHOR_OPS'
export const OP_MARKER_VALUE = 'v1'
/** The spawn's directive text, so a request-local override can tell base from override. */
export const DIRECTIVES_BASE_ENV = 'PHOSPHOR_DIRECTIVES_BASE'
/** The daemon's Headroom relay socket for this lane. */
export const HEADROOM_SOCKET_ENV = 'PHOSPHOR_HEADROOM_SOCKET'
export const CONFIRM_TITLE_PREFIX = 'Phosphor: '
export const LANE_CONTROLS_SLOT = 'phosphor/lane-controls/v1'
/** The lane's tool: a run that ends on its terminating result continues after a reload. */
export const OP_TOOL_NAME = 'phosphor'
/** Internal, never in the agent catalog: a lane reports its live sub-agent work. */
export const LANE_LIVENESS_OP = 'lane.liveness'

export const LANE_WAIT_TIMEOUT = { default: 300, max: 1800 } as const
export const LANE_WAIT_DEADLINE_MS = (LANE_WAIT_TIMEOUT.max + 60) * 1000

export const OP_CHANNEL_LIMITS = {
  idChars: 64,
  argvItems: 64,
  argvItemChars: 4096,
  deadlineMs: LANE_WAIT_DEADLINE_MS,
  /**
   * UTF-8 bytes of an editor prefill. Twice `argsBytes`, because content is
   * JSON-escaped inside it; the lane refuses above it as `too-large`, the
   * owner as `bad-request` before parsing. The args budget itself is checked
   * by `parseOpChannelRequest`.
   */
  prefillBytes: 2 * OPS_LIMITS.argsBytes,
} as const

export interface SwarmFacts {
  readonly available: boolean
  readonly requested: boolean
  readonly enabled: boolean
  readonly lastBy: 'user' | 'agent'
  /** The user turned Swarm off on this branch: the agent cannot turn it on. */
  readonly userOff: boolean
}

/** What the tool knows about its own lane, sent with each request. Reported, not proven. */
export interface OpFacts {
  readonly swarm?: SwarmFacts
  readonly contextFiles?: { readonly off: readonly string[]; readonly userOff: readonly string[] }
  readonly subagentsLive?: boolean
}

/** A catalog op: a command line (`argv`, from the agent's tool) or a structured `op` (Brain). */
export interface OpRequestEnvelope {
  readonly v: 1
  readonly id: string
  readonly argv?: readonly string[]
  /** The tool's content argument, mapped to the op's content flag or routine instructions; counted in `argsBytes`. */
  readonly content?: string
  readonly reason?: string
  readonly op?: string
  readonly input?: Readonly<Record<string, unknown>>
  readonly confirm?: OpsConfirmRef
  readonly deadlineMs: number
  readonly facts?: OpFacts
}

/** Live sub-agent work, so a service pause can wait for it. The owner answers `ok`. */
export interface LaneLivenessMessage {
  readonly v: 1
  readonly id: string
  readonly op: typeof LANE_LIVENESS_OP
  readonly subagents: number
}

export type OpChannelRequest = OpRequestEnvelope | LaneLivenessMessage

/** What the owner asks the lane's own extensions to apply after an op. */
export type LaneEffect =
  | { readonly kind: 'swarm'; readonly enabled: boolean; readonly reason: string }
  | { readonly kind: 'contextFiles'; readonly args: string }
  | { readonly kind: 'pr'; readonly action: 'pin' | 'hide' | 'clear'; readonly url: string }
  | { readonly kind: 'notify'; readonly message: string; readonly level: 'info' | 'warning' }

export type OpReplyEnvelope = { readonly op?: string } & (
  | {
      readonly v: 1
      readonly id: string | null
      readonly status: 'ok'
      readonly text: string
      readonly applies: OpApplies
      readonly data?: unknown
      readonly next?: string
      readonly read?: true
      readonly effects?: readonly LaneEffect[]
      readonly terminate?: true
      readonly untrusted?: true
      readonly auditId?: string
    }
  | {
      readonly v: 1
      readonly id: string | null
      readonly status: 'confirm'
      readonly confirmId: string
      readonly digest: string
      readonly title: string
      readonly message: string
      readonly timeoutMs: number
    }
  | {
      readonly v: 1
      readonly id: string | null
      readonly status: 'denied' | 'error'
      readonly code: OpsDenyCode | 'timeout' | 'aborted'
      readonly text: string
      readonly data?: unknown
    }
  /** Nothing listens on the channel. */
  | {
      readonly v: 1
      readonly id: string | null
      readonly status: 'unsupported'
      readonly code: 'no-owner'
    }
)

/** The reply an RPC client writes when no owner listens (no `phosphor-op` listener). */
export function noOwnerReply(id: string | null): OpReplyEnvelope {
  return { v: 1, id, status: 'unsupported', code: 'no-owner' }
}

/** Every code a denied or error reply may carry. */
export const OP_REPLY_CODES = [...OPS_DENY_CODES, 'timeout', 'aborted'] as const

const requestId = (v: unknown): v is string =>
  text(v, OP_CHANNEL_LIMITS.idChars) && /^[A-Za-z0-9_-]+$/.test(v)
const bools = (v: Record<string, unknown>, keys: readonly string[]) =>
  keys.every((k) => typeof v[k] === 'boolean')
const kinds = (v: unknown): string[] | null =>
  Array.isArray(v) && v.length <= 8 && v.every((k) => text(k, 32)) ? [...v] : null

function facts(v: unknown): OpFacts | null {
  if (!record(v)) return null
  const s = v.swarm
  const c = v.contextFiles
  const swarmOk =
    s === undefined ||
    (record(s) &&
      bools(s, ['available', 'requested', 'enabled', 'userOff']) &&
      (s.lastBy === 'user' || s.lastBy === 'agent'))
  const off = record(c) ? kinds(c.off) : null
  const userOff = record(c) ? kinds(c.userOff) : null
  if (!swarmOk || (c !== undefined && (!off || !userOff))) return null
  if (v.subagentsLive !== undefined && typeof v.subagentsLive !== 'boolean') return null
  return {
    ...(record(s)
      ? {
          swarm: {
            available: s.available === true,
            requested: s.requested === true,
            enabled: s.enabled === true,
            lastBy: s.lastBy === 'agent' ? 'agent' : 'user',
            userOff: s.userOff === true,
          },
        }
      : {}),
    ...(off && userOff ? { contextFiles: { off, userOff } } : {}),
    ...(typeof v.subagentsLive === 'boolean' ? { subagentsLive: v.subagentsLive } : {}),
  }
}

const bytes = (v: unknown): number => (v === undefined ? 0 : utf8Length(JSON.stringify(v)))

function envelope(v: Record<string, unknown>, id: string): OpRequestEnvelope | null {
  const { argv, op, input, content, reason } = v
  const confirm = v.confirm === undefined ? undefined : parseOpsConfirmRef(v.confirm)
  const f = v.facts === undefined ? undefined : facts(v.facts)
  const contentBytes = typeof content === 'string' ? utf8Length(content) : 0
  if (
    (argv === undefined) === (op === undefined) ||
    (argv !== undefined &&
      (!Array.isArray(argv) ||
        argv.length > OP_CHANNEL_LIMITS.argvItems ||
        !argv.every((a) => text(a, OP_CHANNEL_LIMITS.argvItemChars, 0)))) ||
    (op !== undefined && !isOpName(op)) ||
    (input !== undefined && (op === undefined || !record(input))) ||
    (content !== undefined && typeof content !== 'string') ||
    contentBytes > OPS_LIMITS.contentBytes ||
    bytes(argv) + bytes(input) + contentBytes > OPS_LIMITS.argsBytes ||
    (reason !== undefined && !text(reason, OPS_LIMITS.reasonChars)) ||
    confirm === null ||
    !integer(v.deadlineMs, 1) ||
    v.deadlineMs > OP_CHANNEL_LIMITS.deadlineMs ||
    f === null
  )
    return null
  return {
    v: 1,
    id,
    ...(Array.isArray(argv)
      ? { argv: argv.filter((a): a is string => typeof a === 'string') }
      : {}),
    ...(typeof content === 'string' ? { content } : {}),
    ...(typeof reason === 'string' ? { reason } : {}),
    ...(typeof op === 'string' ? { op } : {}),
    ...(record(input) ? { input } : {}),
    ...(confirm ? { confirm } : {}),
    deadlineMs: v.deadlineMs,
    ...(f ? { facts: f } : {}),
  }
}

/** The owner's reading of an editor prefill. Null refuses it as `bad-request`. */
export function parseOpChannelRequest(prefill: string): OpChannelRequest | null {
  let v: unknown
  try {
    v = JSON.parse(prefill)
  } catch {
    return null
  }
  if (!record(v) || v.v !== 1 || !requestId(v.id)) return null
  if (v.op === LANE_LIVENESS_OP)
    return integer(v.subagents) && v.subagents <= 10_000
      ? { v: 1, id: v.id, op: LANE_LIVENESS_OP, subagents: v.subagents }
      : null
  return envelope(v, v.id)
}
