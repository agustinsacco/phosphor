import type { BrainAccess } from '@phosphor/shared/brain-access'
import { isUuid } from '@phosphor/shared/control-api'
import {
  BRAIN_APPROVAL,
  BRAIN_METHODS,
  isBrainSurfaceOp,
  type HostBrainMethod,
} from '@phosphor/shared/host-brain'
import { parseHostBrainRequest, type HostBrainRequest } from '@phosphor/shared/host-brain-request'
import { projectHostBrainResult } from '@phosphor/shared/host-brain-result'
import {
  OPS_LIMITS,
  OPS_RUN,
  parseOpsRunRequest,
  type OpsRunRequest,
  type OpsRunResult,
} from '@phosphor/shared/host-protocol-ops'
import { utf8Length } from '@phosphor/shared/host-protocol'
import { sendFrame, type FrameLinkFactory } from './adapter'
import {
  brainRequirement,
  createBrainApprovals,
  deniedBrain,
  type BrainAdmit,
  type BrainApprover,
} from './brain-approvals'
import type { AuthenticatedFrame, ReadyConnection } from './connection'

export interface BrainSurfaceAuthority {
  /**
   * Who acts: the connection's authenticated client, or for an approved command-line request
   * the authenticated approver's, for that one request. Never a label the caller supplied.
   */
  readonly client: ReadyConnection['client']
  readonly connectionId: string
  /** Check inside the writer/controller immediately before every side effect. */
  admit(): boolean
}

export type BrainSurfaceOutcome =
  | { status: 'ok'; data: unknown }
  | { status: 'stale' | 'disabled' | 'unavailable' | 'not-controller' | 'busy' | 'not-found' }

/** Per-operation binding only. Don't pass the wire envelope into the Brain Agent tool API. */
export type BrainSurfaceHandlers = {
  [K in HostBrainMethod]: (
    request: HostBrainRequest<K>,
    authority: BrainSurfaceAuthority,
  ) => BrainSurfaceOutcome | Promise<BrainSurfaceOutcome>
}

const forbidden = () => deniedBrain('forbidden', 'Brain access was not authorized.')
const badRequest = () => deniedBrain('bad-request', 'Invalid Brain request.')
const unsupported = () => deniedBrain('unsupported', 'This Host does not serve Brain.')
const failures = {
  stale: 'Brain changed. Reload this Host before trying again.',
  disabled: 'Brain is disabled on this Host.',
  unavailable: 'Brain is temporarily unavailable on this Host.',
  'not-controller': 'The Brain Agent controller changed. Reload this lane.',
  busy: 'Brain is busy. Check its current status.',
  'not-found': 'This Brain record was not found on this Host.',
} as const

// Redact output even from a buggy handler. No handler input/result enters the ops audit.
function outcome(
  method: HostBrainMethod,
  result: BrainSurfaceOutcome,
  clientId: string,
): OpsRunResult {
  if (result.status !== 'ok')
    return {
      status: 'ok',
      applies: 'now',
      text: failures[result.status],
      data: { brainRefusal: result.status },
    }
  let data = result.data
  if (
    (method === 'brain:laneShow' || method === 'brain:laneWatch') &&
    data &&
    typeof data === 'object' &&
    'controller' in data
  ) {
    const c = data.controller
    if (c && typeof c === 'object' && 'clientId' in c && 'label' in c)
      data = { ...data, controller: { self: c.clientId === clientId, label: c.label } }
  }
  const parsed = projectHostBrainResult(method, data)
  if (
    !parsed ||
    utf8Length(JSON.stringify(parsed.value)) >
      (BRAIN_METHODS[method][1] ? OPS_LIMITS.resultBytes - 200 : OPS_LIMITS.callDataBytes - 200)
  )
    return deniedBrain(
      'too-large',
      'The Brain result could not be shown safely. Check this Host before retrying.',
    )
  return { status: 'ok', applies: 'now', text: 'Brain operation completed.', data: parsed.value }
}

function wireRequest(
  frame: AuthenticatedFrame,
): { write: boolean; request: OpsRunRequest | null } | null {
  if (
    frame.type === 'call' &&
    frame.method === OPS_RUN &&
    frame.params &&
    typeof frame.params === 'object' &&
    'op' in frame.params &&
    isBrainSurfaceOp(frame.params.op)
  )
    return { write: false, request: parseOpsRunRequest(frame.params) }
  if (frame.type === 'command' && frame.op.type === OPS_RUN && isBrainSurfaceOp(frame.op.op)) {
    const { type: _type, ...request } = frame.op
    return { write: true, request }
  }
  return null
}

function respond(connection: ReadyConnection, frame: AuthenticatedFrame, data: OpsRunResult) {
  if (connection.socket.bufferedBytes() > OPS_LIMITS.callDataBytes * 4) {
    connection.socket.close(4429, '4429')
    return
  }
  if (frame.type === 'call')
    sendFrame(connection.socket, { type: 'result', id: frame.id, ok: true, data })
  else if (frame.type === 'command')
    sendFrame(connection.socket, {
      type: 'receipt',
      receipt: { requestId: frame.requestId, status: 'done', data },
    })
}

function handleApproval(
  connection: ReadyConnection,
  approvals: ReturnType<typeof createBrainApprovals>,
  approve: (requirement: Parameters<BrainAdmit>[0]) => BrainApprover,
  write: boolean,
  { args, confirm }: OpsRunRequest,
) {
  const kind = connection.principal?.kind
  const local = kind === 'local'
  const surface = kind === 'owner' || kind === 'grant-user'
  if (confirm) return badRequest()
  if (
    local &&
    !write &&
    Object.keys(args).length === 2 &&
    args.action === 'status' &&
    isUuid(args.id)
  )
    return approvals.status(connection, args.id)
  if (!surface) return forbidden()
  if (!write && Object.keys(args).length === 1 && args.action === 'list')
    return approvals.list(connection, approve)
  if (
    write &&
    Object.keys(args).length === 3 &&
    args.action === 'answer' &&
    isUuid(args.id) &&
    typeof args.approved === 'boolean'
  )
    return approvals.answer(connection, args.id, args.approved, approve)
  return badRequest()
}

async function runHandler(
  handlers: BrainSurfaceHandlers,
  action: HostBrainRequest,
  authority: BrainSurfaceAuthority,
) {
  // The key and request were parsed together; TS can't narrow an indexed union of functions.
  const handler = handlers[action.method] as (
    request: HostBrainRequest,
    authority: BrainSurfaceAuthority,
  ) => ReturnType<BrainSurfaceHandlers[HostBrainMethod]>
  const result = await handler(action, authority)
  return authority.admit() ? outcome(action.method, result, authority.client.id) : forbidden()
}

type BrainRight = BrainAccess | 'sessions.control'

/**
 * One connection's live Brain authority: its rights and `sessions.control`, each with an epoch
 * that a renewal which drops the right advances, so an admission taken before stays revoked even
 * if the right comes back.
 */
function connectionAuthority(connection: ReadyConnection) {
  const kind = connection.principal?.kind
  const surface = kind === 'owner' || kind === 'grant-user'
  let rights = surface ? (connection.brainAccess ?? []) : []
  let sessionsControl = connection.caps.includes('sessions.control')
  const epochs = new Map<BrainRight, number>()
  let closed = false
  const connected = () =>
    !closed && connection.socket.isOpen() && (connection.credentialLive?.() ?? false)
  const holds = (right: BrainRight) =>
    right === 'sessions.control' ? sessionsControl : rights.includes(right)
  const revoke = (right: BrainRight) => epochs.set(right, (epochs.get(right) ?? 0) + 1)
  /** A grant user acts on Brain Agent's lane only while it may control sessions. */
  const admit: BrainAdmit = ({ rights: asked, agentLane }) => {
    const needed = [
      ...asked,
      ...(agentLane && kind === 'grant-user' ? ['sessions.control' as const] : []),
    ]
    const captured = needed.map((right) => [right, epochs.get(right)] as const)
    const allowed = surface && needed.every(holds)
    return () =>
      allowed &&
      connected() &&
      captured.every(([right, epoch]) => holds(right) && epochs.get(right) === epoch)
  }
  return {
    surface,
    local: kind === 'local',
    connected,
    admit,
    approver: (requirement: Parameters<BrainAdmit>[0]): BrainApprover => ({
      client: connection.client,
      admit: admit(requirement),
    }),
    renew(caps: readonly string[], next: readonly BrainAccess[] | undefined) {
      for (const right of rights) if (!next?.includes(right)) revoke(right)
      rights = surface ? (next ?? []) : []
      const control = caps.includes('sessions.control')
      if (sessionsControl && !control) revoke('sessions.control')
      sessionsControl = control
    },
    close() {
      closed = true
    },
  }
}

/** Requests in flight: at most 32 per adapter and 4 per connection. */
interface InFlight {
  active: number
}

interface ConnectionContext {
  readonly handlers: BrainSurfaceHandlers | undefined
  readonly approvals: ReturnType<typeof createBrainApprovals>
  readonly shared: InFlight
  readonly own: InFlight
  readonly connection: ReadyConnection
  readonly authority: ReturnType<typeof connectionAuthority>
}

/** One request on one connection: refused, sent for approval, or run as who it acts for. */
async function runRequest(
  context: ConnectionContext,
  write: boolean,
  request: OpsRunRequest | null,
): Promise<OpsRunResult> {
  const { handlers, approvals, shared, own, connection, authority } = context
  const { surface, local, connected } = authority
  if (!handlers) return unsupported()
  if (!connected() || (!surface && !local) || request?.actor) return forbidden()
  if (!request || request.batch || request.reason !== undefined || request.page !== undefined)
    return badRequest()
  if (request.op === BRAIN_APPROVAL)
    return handleApproval(connection, approvals, authority.approver, write, request)
  const action = parseHostBrainRequest(request.args)
  if (!action || BRAIN_METHODS[action.method][1] !== write) return badRequest()
  const direct = authority.admit(brainRequirement(action.method))
  if (surface && (!direct() || request.confirm)) return forbidden()
  if (local && !request.confirm) return approvals.request(connection, action, request.args)
  if (shared.active >= 32 || own.active >= 4) return deniedBrain('busy', failures.busy)
  // An approved request acts as its approver, for this one redemption only.
  const approved =
    local && request.confirm ? approvals.consume(connection, request.confirm, request.args) : null
  const authorized = local ? () => connected() && approved?.admit() === true : direct
  const client = local ? approved?.client : connection.client
  if (!client || !authorized()) return forbidden()
  shared.active++
  own.active++
  try {
    return await runHandler(handlers, action, {
      client,
      connectionId: connection.connectionId,
      admit: authorized,
    })
  } catch {
    return deniedBrain(
      'unavailable',
      'Brain did not confirm the operation. Check this Host before trying again.',
    )
  } finally {
    own.active--
    shared.active--
  }
}

export function createBrainAdapter(handlers?: BrainSurfaceHandlers): FrameLinkFactory {
  const approvals = createBrainApprovals()
  const shared: InFlight = { active: 0 }
  return (connection) => {
    const authority = connectionAuthority(connection)
    const context = { handlers, approvals, shared, own: { active: 0 }, connection, authority }
    return {
      handle(frame) {
        const parts = wireRequest(frame)
        if (!parts) return false
        void runRequest(context, parts.write, parts.request)
          .then((result) => {
            if (authority.connected()) respond(connection, frame, result)
          })
          .catch(() => {
            if (authority.connected()) connection.socket.close(4429, '4429')
          })
        return true
      },
      renew(caps, next) {
        authority.renew(caps, next)
        approvals.clear()
      },
      close() {
        authority.close()
        approvals.clear(connection.connectionId)
      },
    }
  }
}

export interface BrainSurfaceBinding {
  readonly link: FrameLinkFactory
}

/** Pass the same binding to TCP and the owner socket so they share approval state and limits. */
export function bindBrainSurface(handlers: BrainSurfaceHandlers): BrainSurfaceBinding {
  return { link: createBrainAdapter(handlers) }
}
