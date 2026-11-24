import type { GrantClient } from '@phosphor/shared/host-grant'
import { HOST_LIMITS, utf8Length, type CallErrorCode } from '@phosphor/shared/host-protocol'
import {
  isAnyLocalOwnerMethod,
  isOwnerMethod,
  parseOwnerParams,
  type OwnerCalls,
  type OwnerMethod,
} from '@phosphor/shared/host-protocol-owner'
import { sendFrame, type FrameLinkFactory } from '../api/adapter'
import type { ConnectionPrincipal } from '../api/principal'

/** A socket principal: the attested owner or any other same-user process. */
export type SocketPrincipal = Extract<ConnectionPrincipal, { kind: 'owner' | 'local' }>

/** Who made an owner call. Handlers read `principal.kind`; only the socket produces these. */
export interface OwnerCallContext {
  readonly principal: SocketPrincipal
  readonly client: GrantClient
  /** Aborted when this authenticated connection closes. */
  readonly signal: AbortSignal
  readonly connectionId: string
}

export type OwnerHandler<M extends OwnerMethod> = (
  params: OwnerCalls[M]['params'],
  context: OwnerCallContext,
) => Promise<OwnerCalls[M]['result']>

/**
 * The owner methods this daemon serves. A missing method answers
 * `unsupported`; each later package adds its own (D4 `machine.pause`, P4a
 * `owner.migrate.*`, D8 `headroom.*`, D9 `app.service.register`).
 */
export type OwnerHandlers = { readonly [M in OwnerMethod]?: OwnerHandler<M> }

/** A handler's refusal, answered with its code. Any other throw answers `internal`. */
export class OwnerCallRefused extends Error {
  readonly code: CallErrorCode

  constructor(code: CallErrorCode, message: string = code) {
    super(message)
    this.name = 'OwnerCallRefused'
    this.code = code
  }
}

function runHandler<M extends OwnerMethod>(
  handlers: OwnerHandlers,
  method: M,
  params: OwnerCalls[M]['params'],
  context: OwnerCallContext,
): Promise<OwnerCalls[M]['result']> | null {
  const handler = handlers[method] as OwnerHandler<M> | undefined
  return handler ? handler(params, context) : null
}

/**
 * Owner calls, first in the chain so they work in standby with no lane
 * service. Only socket principals reach them: a grant connection's owner
 * method falls through to the lane adapter, as on every older Host. A `local`
 * principal gets `forbidden` except for the methods open to every local caller.
 */
export function createOwnerAdapter(handlers: OwnerHandlers = {}): FrameLinkFactory {
  return (connection) => {
    const principal = connection.principal
    if (principal?.kind !== 'owner' && principal?.kind !== 'local') return null
    const lifetime = new AbortController()
    const context: OwnerCallContext = {
      signal: lifetime.signal,
      principal,
      client: connection.client,
      connectionId: connection.connectionId,
    }
    const { socket } = connection
    const fail = (id: string, code: CallErrorCode, message: string = code) =>
      sendFrame(socket, { type: 'result', id, ok: false, error: { code, message } })
    /** Answers one call once its handler settles; every outcome is a result frame. */
    async function answer(id: string, pending: Promise<unknown>) {
      try {
        const data = await pending
        const result = { type: 'result' as const, id, ok: true as const, data }
        if (utf8Length(JSON.stringify(result)) > HOST_LIMITS.outboundFrameBytes)
          fail(id, 'too-large')
        else sendFrame(socket, result)
      } catch (error) {
        if (error instanceof OwnerCallRefused)
          fail(id, error.code, error.message.slice(0, HOST_LIMITS.messageChars))
        else fail(id, 'internal')
      }
    }
    return {
      close: () => lifetime.abort(),
      handle(frame) {
        if (frame.type !== 'call' || !isOwnerMethod(frame.method)) return false
        const { id, method } = frame
        if (principal.kind !== 'owner' && !isAnyLocalOwnerMethod(method)) {
          fail(id, 'forbidden')
          return true
        }
        const params = parseOwnerParams(method, frame.params)
        if (params === null) {
          fail(id, 'bad-request')
          return true
        }
        const pending = runHandler(handlers, method, params, context)
        if (!pending) {
          fail(id, 'unsupported')
          return true
        }
        void answer(id, pending)
        return true
      },
    }
  }
}
