/**
 * The owner's end of the op channel (`@phosphor/shared/ops` `channel.ts`):
 * reserved `editor` requests from a marker session's `phosphor` tool are
 * consumed here, before `SessionActivity` and before any `extension-ui`
 * listener, so dialogs, routines, lane reload and Host forwarding never see
 * one. pi keeps an unanswered editor pending even after an abort and ignores a
 * second reply to the same id, so every consumed id gets exactly one answer:
 * the owner's, `no-owner` when nothing listens, `bad-request` when malformed,
 * `aborted` on Stop, or `timeout` from the backstop.
 */
import {
  LANE_LIVENESS_OP,
  OP_CHANNEL_LIMITS,
  OP_MARKER_ENV,
  OP_MARKER_VALUE,
  OP_METHOD,
  OP_TITLE,
  noOwnerReply,
  parseOpChannelRequest,
  type LaneLivenessMessage,
  type OpChannelRequest,
  type OpReplyEnvelope,
  type OpRequestEnvelope,
} from '@phosphor/shared/ops'
import type { ExtensionUIRequest, ExtensionUIResponse } from '@shared/rpc'
import type { RuntimeLog } from '../file-log'

/** What a `phosphor-op` listener receives. `respond` answers once; later calls are ignored. */
export interface OpChannelRequestEvent {
  readonly request: OpRequestEnvelope
  respond(reply: OpReplyEnvelope): void
}

/** What a client emits for its owner, beside its own events. */
export interface OpChannelEvents {
  /** A marker session's op request, never an `extension-ui`; answer it with `respond`. */
  'phosphor-op': [OpChannelRequestEvent]
  /** Stop answered every pending op `aborted`; the owner cancels the lane's queued ops. */
  'phosphor-op-stop': []
  /** Live sub-agents a marker lane reported over the channel (`lane.liveness`). */
  'lane-liveness': [number]
}

/** Past the request's own deadline, the owner's dispatcher has had its chance to answer. */
export const OP_BACKSTOP_GRACE_MS = 5_000

export interface OpChannelPorts {
  write(response: ExtensionUIResponse): void
  log: RuntimeLog
  /** True when an owner listens for `phosphor-op`. */
  listening(): boolean
  emitRequest(event: OpChannelRequestEvent): void
  emitLiveness(subagents: number): void
  /** After Stop answered the pending requests: the owner cancels the lane's queued ops. */
  emitStop(): void
}

/**
 * The spawn's own `env`, never the inherited environment: a Phosphor started
 * from a lane's shell inherits that lane's marker, and its lanes must not
 * treat it as theirs.
 */
export function opMarkerSet(env: Readonly<Record<string, string>> | undefined): boolean {
  return env?.[OP_MARKER_ENV] === OP_MARKER_VALUE
}

/**
 * The child's environment: the spawn's own `env` over the inherited one unless
 * `inheritEnv` is false. An inherited marker never reaches an unmarked spawn.
 */
/**
 * Brain is reached over the op channel, never with a credential in a lane's env
 * (`@phosphor/brain-client`'s node transport names the first two). A parent
 * process launched with any of these must not pass them on.
 */
const LANE_WITHHELD_ENV = [
  'PHOSPHOR_BRAIN_ENDPOINT',
  'PHOSPHOR_BRAIN_TOKEN',
  'PHOSPHOR_BRAIN_EMBEDDING_MODEL_DIR',
  'PHOSPHOR_BRAIN_TEST_EMBEDDINGS',
] as const

/** Desktop's Brain lane's private bridge (`PiSpawnOptions.brainConnection`). */
export interface BrainLaneConnection {
  readonly endpoint: string
  readonly token: string
}

/**
 * `brainConnection` is the one way Brain credentials reach a child: a typed
 * spawn field set only for Desktop's Brain lane, added after the scrub.
 */
export function opChildEnv(
  own: Readonly<Record<string, string>> | undefined,
  inheritEnv: boolean,
  brainConnection?: BrainLaneConnection,
): Record<string, string | undefined> {
  const env = inheritEnv ? { ...process.env, ...own } : { ...own }
  if (!own?.PHOSPHOR_HEADROOM_SOCKET) delete env.PHOSPHOR_HEADROOM_SOCKET
  if (!opMarkerSet(own)) delete env[OP_MARKER_ENV]
  for (const key of LANE_WITHHELD_ENV) delete env[key]
  if (brainConnection) {
    env.PHOSPHOR_BRAIN_ENDPOINT = brainConnection.endpoint
    env.PHOSPHOR_BRAIN_TOKEN = brainConnection.token
  }
  return env
}

const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8')

/** `parseOpChannelRequest` returns this op name only for a liveness message. */
const isLiveness = (request: OpChannelRequest): request is LaneLivenessMessage =>
  request.op === LANE_LIVENESS_OP

const failure = (
  id: string | null,
  code: 'bad-request' | 'unavailable' | 'timeout' | 'aborted',
  text: string,
): OpReplyEnvelope => ({ v: 1, id, status: 'error', code, text })

export class OpChannel {
  /** Unanswered requests by pi's editor id: the envelope's own id and the backstop timer. */
  private readonly pending = new Map<string, { id: string; timer: NodeJS.Timeout }>()

  constructor(
    /** Decided once from the spawn's own env (`opMarkerSet`). */
    readonly marked: boolean,
    private readonly ports: OpChannelPorts,
  ) {}

  get pendingCount(): number {
    return this.pending.size
  }

  /** True when the request belonged to the channel; it is then answered or owned here. */
  consume(request: ExtensionUIRequest): boolean {
    if (!this.marked || request.method !== OP_METHOD || request.title !== OP_TITLE) return false
    const prefill = request.prefill ?? ''
    const parsed =
      byteLength(prefill) > OP_CHANNEL_LIMITS.prefillBytes ? null : parseOpChannelRequest(prefill)
    if (!parsed) {
      this.ports.log('pi', 'op malformed', { requestId: request.id, bytes: byteLength(prefill) })
      this.write(request.id, failure(null, 'bad-request', 'Phosphor could not read this request.'))
      return true
    }
    if (isLiveness(parsed)) {
      this.write(request.id, { v: 1, id: parsed.id, status: 'ok', text: '', applies: 'now' })
      this.ports.emitLiveness(parsed.subagents)
      return true
    }
    if (!this.ports.listening()) {
      this.write(request.id, noOwnerReply(parsed.id))
      return true
    }
    this.track(request.id, parsed)
    try {
      this.ports.emitRequest({
        request: parsed,
        respond: (reply) => this.answer(request.id, reply),
      })
    } catch (error) {
      this.ports.log('pi', 'op listener failed', { requestId: request.id, error: String(error) })
      this.answer(request.id, failure(parsed.id, 'unavailable', 'Phosphor could not run this.'))
    }
    return true
  }

  /**
   * Stop: answer every pending request `aborted` now. The abort is already
   * written, and pi acknowledges it only once the tool's editor resolves.
   */
  stop(): void {
    for (const [requestId, { id }] of [...this.pending])
      this.answer(requestId, failure(id, 'aborted', 'Phosphor stopped this operation.'))
    this.ports.emitStop()
  }

  /** pi exited: its pending entries died with it, and nothing can be written. */
  closed(): void {
    for (const { timer } of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
  }

  private track(requestId: string, request: OpRequestEnvelope): void {
    const timer = setTimeout(
      () => this.answer(requestId, failure(request.id, 'timeout', 'Phosphor did not answer.')),
      request.deadlineMs + OP_BACKSTOP_GRACE_MS,
    )
    timer.unref()
    this.pending.set(requestId, { id: request.id, timer })
  }

  private answer(requestId: string, reply: OpReplyEnvelope): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(requestId)
    this.write(requestId, reply)
  }

  private write(requestId: string, reply: OpReplyEnvelope): void {
    this.ports.write({
      type: 'extension_ui_response',
      id: requestId,
      value: JSON.stringify(reply),
    })
  }
}
