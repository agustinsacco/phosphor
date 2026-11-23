import { OPS_RUN, parseOpsRunRequest, type OpsRunRequest } from '@phosphor/shared/host-protocol-ops'
import { OP_CATALOG } from '@phosphor/shared/ops-catalog'
import type { OpClass } from '@phosphor/shared/ops'
import type { HostCapability } from '@phosphor/shared/remote-host'
import type { OpPrincipal, OpsDispatcher } from '@phosphor/session-runtime/ops/types'
import type { FrameSocket } from '@phosphor/shared/host-protocol'
import { sendFrame, type FrameLink, type FrameLinkFactory } from '../api/adapter'
import { opPrincipalFor } from '../api/principal'

/** `ops.run` needs no capability: the dispatcher decides per principal and op. */
export const OPS_RUN_CAPABILITY: HostCapability | null = null

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

export interface OpsAdapterPorts {
  /** Absent until the Host serves ops: `ops.run` then answers `unsupported`, as an older Host does. */
  dispatcher?: Pick<OpsDispatcher, 'run'>
  queue?: OpsQueue
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
  const { dispatcher } = ports
  const queue = ports.queue ?? createOpsQueue()
  return (connection) => {
    if (!dispatcher) return unsupportedOps(connection.socket)
    const run = dispatcher.run.bind(dispatcher)
    const { socket, client } = connection
    const principal = connection.principal ?? { kind: 'grant-user', clientId: client.id }
    let closed = false
    function execute(request: OpsRunRequest) {
      const asked = opPrincipalFor(principal, client, request.actor)
      return queue.run(queueKey(asked), opClass(request), () => run(asked, request))
    }
    return {
      close() {
        closed = true
      },
      handle(frame) {
        if (frame.type === 'call' && frame.method === OPS_RUN) {
          const request = parseOpsRunRequest(frame.params)
          if (!request) {
            const error = { code: 'bad-request', message: 'bad-request' } as const
            sendFrame(socket, { type: 'result', id: frame.id, ok: false, error })
            return true
          }
          void execute(request).then(
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
        void execute(request).then(
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
