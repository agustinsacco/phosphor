/**
 * `createOpsDispatcher`: the owner's one entry point for agent-control ops,
 * from a lane's `phosphor` tool (`runFromTool`) and from every other principal
 * (`run`). Ops run on a per-principal queue, with a separate queue for class
 * `service` (Brain) so a search never waits behind a slow change. A tool
 * request is always answered: by its result, `timeout` at its deadline, or
 * `aborted` when the lane stops. Living contract: docs/agent-control.md.
 */
import { isOpName, type OpsRunRequest, type OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import type { OpReplyEnvelope, OpRequestEnvelope } from '@phosphor/shared/ops'
import { createLaneDeferred, type LaneDeferredQueue } from './deferred'
import { createOpLimits } from './limits'
import { createOpPipeline, type OpOutcome, type OpPipeline, type OpRunExtras } from './pipeline'
import { principalKey } from './principals'
import type { OpsDispatcherDeps } from './ports'
import type { OpPrincipal, OpsBinding, OpsDispatcher } from './types'

type ToolRequest =
  | { readonly request: OpsRunRequest; readonly hosts?: readonly string[] | 'all' }
  | { readonly error: string; readonly op?: string }

/** One serial chain per key; a failed task never blocks the next. */
function createOpQueues() {
  const tails = new Map<string, Promise<unknown>>()
  return {
    run<T>(key: string, task: () => Promise<T>): Promise<T> {
      const next = (tails.get(key) ?? Promise.resolve()).then(task, task)
      const tail = next.then(
        () => undefined,
        () => undefined,
      )
      tails.set(key, tail)
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key)
      })
      return next
    },
  }
}

function toolRequest(deps: OpsDispatcherDeps, envelope: OpRequestEnvelope): ToolRequest {
  const shared = {
    ...(envelope.confirm ? { confirm: envelope.confirm } : {}),
  }
  if (envelope.argv) {
    const parsed = deps.parseArgv(envelope.argv, envelope.content, envelope.reason)
    if (!parsed.ok)
      return {
        op: parsed.op,
        error: parsed.usage ? `${parsed.error}\n${parsed.usage}` : parsed.error,
      }
    const reason = envelope.reason ?? parsed.reason
    return {
      request: {
        op: parsed.op,
        args: parsed.args,
        ...shared,
        ...(reason !== undefined ? { reason } : {}),
        ...(parsed.page !== undefined ? { page: parsed.page } : {}),
        ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
      },
      ...(parsed.hosts ? { hosts: parsed.hosts } : {}),
    }
  }
  if (envelope.op === undefined) return { error: 'Name an operation.' }
  return {
    request: {
      op: envelope.op,
      args: envelope.input ?? {},
      ...shared,
      ...(envelope.reason !== undefined ? { reason: envelope.reason } : {}),
    },
  }
}

function toReply(id: string, outcome: OpOutcome, now: number): OpReplyEnvelope {
  const r = outcome.result
  if (r.status === 'denied') return { v: 1, id, status: 'denied', code: r.code, text: r.text }
  if (r.status === 'confirm')
    return {
      v: 1,
      id,
      status: 'confirm',
      confirmId: r.confirmId,
      digest: r.digest,
      title: r.title,
      message: r.message,
      timeoutMs: Math.max(1000, r.expiresAt - now),
    }
  return {
    v: 1,
    id,
    status: 'ok',
    text: r.text,
    applies: r.applies,
    ...(r.data !== undefined ? { data: r.data } : {}),
    ...(r.next !== undefined ? { next: r.next } : {}),
    ...(r.read ? { read: true as const } : {}),
    ...(outcome.effects?.length ? { effects: outcome.effects } : {}),
    ...(outcome.terminate ? { terminate: true as const } : {}),
    ...(outcome.untrusted ? { untrusted: true as const } : {}),
    ...(r.auditId !== undefined ? { auditId: r.auditId } : {}),
  }
}

const failed = (code: 'timeout' | 'aborted', id: string, text: string): OpReplyEnvelope => ({
  v: 1,
  id,
  status: 'error',
  code,
  text,
})

/** The dispatcher's state, shared by its module-level steps. */
interface DispatcherCore {
  readonly deps: OpsDispatcherDeps
  readonly now: () => number
  readonly pipeline: OpPipeline
  readonly queues: ReturnType<typeof createOpQueues>
  readonly deferred: LaneDeferredQueue
  /** Tool and run requests of a lane here, so `cancelLane` can abort them. */
  readonly inflight: Map<string, Set<AbortController>>
}

const STOPPED = 'Phosphor stopped this operation.'

function track(
  core: DispatcherCore,
  principal: OpPrincipal,
): { controller: AbortController; release: () => void } {
  const controller = new AbortController()
  if (principal.kind !== 'agent') return { controller, release: () => undefined }
  const { inflight } = core
  const set = inflight.get(principal.sessionId) ?? new Set<AbortController>()
  set.add(controller)
  inflight.set(principal.sessionId, set)
  return {
    controller,
    release: () => {
      set.delete(controller)
      if (set.size === 0 && inflight.get(principal.sessionId) === set)
        inflight.delete(principal.sessionId)
    },
  }
}

/** Queued per principal and class; a request aborted while queued never runs. */
function execute(
  core: DispatcherCore,
  principal: OpPrincipal,
  request: OpsRunRequest,
  signal: AbortSignal,
  extras: Omit<OpRunExtras, 'signal'> = {},
  onStart?: () => void,
): Promise<OpOutcome | null> {
  // Undo awaits its inverse, which runs on this same principal’s ordinary control queue.
  const group =
    request.op === 'audit.undo' ? request.op : (core.pipeline.spec(request.op)?.class ?? 'control')
  const key = `${principalKey(principal)}|${group}`
  return core.queues.run(key, async () => {
    if (signal.aborted) return null
    onStart?.()
    try {
      return await core.pipeline.execute(principal, request, { ...extras, signal })
    } catch {
      core.deps.log('ops', 'op failed', { op: request.op, phase: 'dispatch' })
      return {
        result: {
          status: 'denied',
          code: 'unavailable',
          text: `${request.op} failed during dispatch. Retry or check the Phosphor service logs.`,
        },
      }
    }
  })
}

async function runOp(
  core: DispatcherCore,
  principal: OpPrincipal,
  request: OpsRunRequest,
  hosts?: OpRunExtras['hosts'],
): Promise<OpsRunResult> {
  const { controller, release } = track(core, principal)
  try {
    const outcome = await execute(core, principal, request, controller.signal, { hosts })
    return outcome?.result ?? { status: 'denied', code: 'unavailable', text: STOPPED }
  } finally {
    release()
  }
}

/** The lane gives us a backstop; only the owner knows the resolved command. */
function toolDeadline(core: DispatcherCore, request: OpsRunRequest, backstop: number): number {
  const spec = core.pipeline.spec(request.op)
  const tier = spec?.tier
  // Target resolution runs after queue admission. Use the shorter budget only
  // when this invocation is a read regardless of the target.
  const read =
    typeof tier === 'function'
      ? tier(request.args, { self: true }) === 'read' &&
        tier(request.args, { self: false }) === 'read'
      : tier === 'read'
  return Math.min(backstop, spec?.deadlineMs ?? (read ? 30_000 : 60_000))
}

/** Always answers: the op's reply, `timeout` at the tool's deadline, or `aborted` on Stop. */
async function runFromTool(
  core: DispatcherCore,
  sessionId: string,
  envelope: OpRequestEnvelope,
): Promise<OpReplyEnvelope> {
  const id = envelope.id
  const principal = core.deps.agentFor(sessionId)
  if (!principal)
    return {
      v: 1,
      id,
      status: 'denied',
      code: 'unavailable',
      text: 'This lane is not known to Phosphor.',
    }
  const parsed = toolRequest(core.deps, envelope)
  if ('error' in parsed)
    return { v: 1, id, op: parsed.op, status: 'denied', code: 'bad-request', text: parsed.error }
  const { op } = parsed.request
  const deadline = toolDeadline(core, parsed.request, envelope.deadlineMs)
  let phase = 'queue'
  const { controller, release } = track(core, principal)
  let settle: (reply: OpReplyEnvelope) => void = () => undefined
  const early = new Promise<OpReplyEnvelope>((resolve) => (settle = resolve))
  const timer = setTimeout(() => {
    core.deps.log('ops', 'op timed out', { op, phase, deadlineMs: deadline })
    settle(
      failed(
        'timeout',
        id,
        `Phosphor timed out during ${phase} after ${deadline / 1000} seconds. ${phase === 'queue' ? 'Wait for the earlier operation to finish, then retry.' : 'Check the result before retrying a change.'}`,
      ),
    )
    controller.abort()
  }, deadline)
  controller.signal.addEventListener('abort', () => settle(failed('aborted', id, STOPPED)), {
    once: true,
  })
  const extras = {
    ...(envelope.facts ? { facts: envelope.facts } : {}),
    ...(parsed.hosts ? { hosts: parsed.hosts } : {}),
  }
  const work = execute(core, principal, parsed.request, controller.signal, extras, () => {
    phase = 'execution'
  }).then((outcome) =>
    outcome ? toReply(id, outcome, core.now()) : failed('aborted', id, STOPPED),
  )
  try {
    const reply = await Promise.race([work, early])
    return isOpName(op) ? { ...reply, op } : reply
  } finally {
    clearTimeout(timer)
    release()
  }
}

export function createOpsDispatcher(binding: OpsBinding, deps: OpsDispatcherDeps): OpsDispatcher {
  const now = deps.now ?? Date.now
  const deferred = createLaneDeferred(binding, deps.log)
  const pipeline = createOpPipeline(binding, deps, { limits: createOpLimits(now), deferred, now })
  const core: DispatcherCore = {
    deps,
    now,
    pipeline,
    queues: createOpQueues(),
    deferred,
    inflight: new Map(),
  }
  const run = (principal: OpPrincipal, request: OpsRunRequest) => runOp(core, principal, request)
  return {
    run,
    async runFromCli(principal, envelope) {
      const parsed = toolRequest(deps, envelope)
      if ('error' in parsed) return { status: 'denied', code: 'bad-request', text: parsed.error }
      return runOp(core, principal, parsed.request, parsed.hosts)
    },
    runFromTool: (sessionId, envelope) => runFromTool(core, sessionId, envelope),
    surfaceAnswered: (sessionId, response, origin) =>
      deps.confirms.surfaceAnswered(sessionId, response, origin),
    confirmSeen: (sessionId, dialog) => deps.confirms.confirmSeen(sessionId, dialog),
    settled: (sessionId) => deferred.settled(sessionId),
    userPrompted: (sessionId) => deferred.userPrompted(sessionId),
    cancelLane(sessionId) {
      for (const controller of core.inflight.get(sessionId) ?? []) controller.abort()
      core.inflight.delete(sessionId)
      deferred.cancel(sessionId)
      deps.confirms.voidSession(sessionId)
    },
    async undo(principal, auditId) {
      if (principal.kind !== 'surface')
        return {
          status: 'denied',
          code: 'forbidden',
          text: 'Only the user can undo an agent change.',
        }
      return deps.undo.run(principal, auditId, run)
    },
  }
}
