import { OPS_RUN, parseOpsRunRequest, type OpsRunRequest } from '@phosphor/shared/host-protocol-ops'
import { OP_CATALOG } from '@phosphor/shared/ops-catalog'
import { parseOpChannelRequest, type OpClass } from '@phosphor/shared/ops'
import type { HostCapability } from '@phosphor/shared/remote-host'
import type { OpPrincipal, OpsDispatcher } from '@phosphor/session-runtime/ops/types'
import type { FrameSocket, ReadyOpFlag } from '@phosphor/shared/host-protocol'
import { sendFrame, type FrameLink, type FrameLinkFactory } from '../api/adapter'
import { opPrincipalFor } from '../api/principal'
import { OPS_CLI } from './cli-method'
import type { HostSurfacePrincipal } from './binding'

/**
 * Where `ops.run` executions wait. Never the Host's machine queue: a long op
 * must not hold lane commands. Each principal has its own FIFO, and `service`
 * ops (Brain) a separate one, so a slow control op never delays them.
 */
export interface OpsQueue {
  run<T>(key: string, opClass: OpClass, task: () => Promise<T>): Promise<T>
}

export function createOpsQueue(): OpsQueue {
  const tails = new Map<string, Promise<unknown>>()
  return {
    run(key, opClass, task) {
      const slot = `${opClass}:${key}`
      const previous = tails.get(slot) ?? Promise.resolve()
      const next = previous.catch(() => undefined).then(task)
      const tail = next.catch(() => undefined)
      tails.set(slot, tail)
      void tail.then(() => {
        if (tails.get(slot) === tail) tails.delete(slot)
      })
      return next
    },
  }
}

function queueKey(principal: OpPrincipal): string {
  switch (principal.kind) {
    case 'surface':
      return `surface:${principal.clientId}`
    case 'machine':
      return `machine:${principal.machineId}:${principal.clientId}`
    case 'local':
      return `local:${principal.clientId}`
    case 'agent':
      return `agent:${principal.sessionId}`
  }
}

function opClass(request: OpsRunRequest): OpClass {
  return OP_CATALOG.find((spec) => spec.name === request.op)?.class ?? 'control'
}

/**
 * Run's one ops slot, shared by both listeners and read per connection: empty
 * until the machine's dispatcher is bound, so a connection made before then
 * answers `unsupported`, as an older Host does.
 */
export interface OpsAdapterPorts {
  dispatcher?: Pick<OpsDispatcher, 'run'> & Partial<Pick<OpsDispatcher, 'runFromCli'>>
  /** The `ready` flags announced beside the bound dispatcher. */
  readyFlags?: ReadonlySet<ReadyOpFlag>
  queue?: OpsQueue
}

/** A surface asks with the capabilities its own connection holds now. */
function withCaps(
  principal: OpPrincipal,
  caps: readonly HostCapability[],
  currentCaps: () => readonly HostCapability[],
): OpPrincipal {
  if (principal.kind !== 'surface') return principal
  const surface: HostSurfacePrincipal = { ...principal, caps: [...caps], currentCaps }
  return surface
}

/** Without a dispatcher every `ops.run`, either form, is `unsupported`: no capability gates it. */
function unsupportedOps(socket: FrameSocket): FrameLink {
  return {
    handle(frame) {
      if (frame.type === 'call' && frame.method === OPS_RUN) {
        const error = { code: 'unsupported', message: 'unsupported' } as const
        sendFrame(socket, { type: 'result', id: frame.id, ok: false, error })
        return true
      }
      if (frame.type !== 'command' || frame.op.type !== OPS_RUN) return false
      const { requestId } = frame
      sendFrame(socket, {
        type: 'receipt',
        receipt: { requestId, status: 'rejected', code: 'unsupported' },
      })
      return true
    },
  }
}

/** `ops.run` as a call (reads) and as a laneless command (writes), ahead of the lane adapter. */
export function createOpsAdapter(ports: OpsAdapterPorts = {}): FrameLinkFactory {
  const queue = ports.queue ?? createOpsQueue()
  return (connection) => {
    const { dispatcher } = ports
    if (!dispatcher) return unsupportedOps(connection.socket)
    const run = dispatcher.run.bind(dispatcher)
    const { socket, client } = connection
    const principal = connection.principal ?? { kind: 'grant-user', clientId: client.id }
    let closed = false
    let liveCaps: readonly HostCapability[] = []
    function execute(request: OpsRunRequest, caps: readonly HostCapability[]) {
      const asked = withCaps(opPrincipalFor(principal, client, request.actor), caps, () =>
        closed ? [] : liveCaps,
      )
      return queue.run(queueKey(asked), opClass(request), () => run(asked, request))
    }
    return {
      close() {
        closed = true
      },
      renew(caps) {
        liveCaps = caps
      },
      handle(frame, caps) {
        liveCaps = caps
        if (frame.type === 'call' && (frame.method === OPS_RUN || frame.method === OPS_CLI)) {
          const task = ():
            ReturnType<typeof execute> | 'bad-request' | 'unsupported' | 'forbidden' => {
            if (frame.method === OPS_RUN) {
              const request = parseOpsRunRequest(frame.params)
              if (request) return execute(request, caps)
            } else {
              if (principal.kind !== 'local') return 'forbidden'
              if (!dispatcher.runFromCli) return 'unsupported'
              const envelope = parseOpChannelRequest(JSON.stringify(frame.params ?? null))
              if (envelope && 'argv' in envelope && envelope.argv && !envelope.facts)
                return dispatcher.runFromCli(principal, envelope)
            }
            return 'bad-request'
          }
          const pending = task()
          if (typeof pending === 'string') {
            const error = { code: pending, message: pending }
            sendFrame(socket, { type: 'result', id: frame.id, ok: false, error })
            return true
          }
          void pending.then(
            (data) => {
              if (!closed) sendFrame(socket, { type: 'result', id: frame.id, ok: true, data })
            },
            () => {
              const error = { code: 'internal', message: 'internal' } as const
              if (!closed) sendFrame(socket, { type: 'result', id: frame.id, ok: false, error })
            },
          )
          return true
        }
        if (frame.type !== 'command' || frame.op.type !== OPS_RUN) return false
        const { requestId } = frame
        const { type: _type, ...request } = frame.op
        // The dispatcher may have acted before failing: say so rather than invent a refusal.
        void execute(request, caps).then(
          (data) => {
            if (!closed)
              sendFrame(socket, { type: 'receipt', receipt: { requestId, status: 'done', data } })
          },
          () => {
            if (!closed)
              sendFrame(socket, { type: 'receipt', receipt: { requestId, status: 'unknown' } })
          },
        )
        return true
      },
    }
  }
}
