import type { FrameSocket, HostFrame } from '@phosphor/shared/host-protocol'
import type { HostCapability } from '@phosphor/shared/remote-host'
import type { AuthenticatedFrame, AuthenticatedHandler, ReadyConnection } from './connection'

/** One link ahead of the lane adapter. `handle` returns true when it answered the frame. */
export interface FrameLink {
  handle(frame: AuthenticatedFrame, caps: readonly HostCapability[]): boolean
  renew?(caps: readonly HostCapability[]): void
  close?(): void
}
/** Null: the link never answers anything on this connection. */
export type FrameLinkFactory = (connection: ReadyConnection) => FrameLink | null

/** A link's small answers. Bounded frames only; the lane adapter owns streaming limits. */
export function sendFrame(socket: FrameSocket, frame: HostFrame): void {
  if (socket.isOpen()) socket.send(JSON.stringify(frame))
}

/** What a connection without a handler answers, so a link-only chain answers the same. */
export function refuseFrame(socket: FrameSocket, frame: AuthenticatedFrame): void {
  if (frame.type === 'subscribe')
    sendFrame(socket, { type: 'subscribe-failed', id: frame.id, code: 'forbidden' })
  else if (frame.type === 'command')
    sendFrame(socket, {
      type: 'receipt',
      receipt: { requestId: frame.requestId, status: 'rejected', code: 'forbidden' },
    })
  else if (frame.type === 'receipt-status')
    sendFrame(socket, {
      type: 'receipt',
      receipt: { requestId: frame.requestId, status: 'unknown' },
    })
  else if (frame.type === 'call')
    sendFrame(socket, {
      type: 'result',
      id: frame.id,
      ok: false,
      error: { code: 'unsupported', message: 'unsupported' },
    })
}

/**
 * The order every authenticated frame takes: owner methods, then `ops.run`,
 * then the machine-principal guard, then the lane adapter. A connection no
 * link answers for gets the lane adapter's handler unchanged, or none.
 */
export function createAdapterChain(
  links: readonly FrameLinkFactory[],
  lanes: ((connection: ReadyConnection) => AuthenticatedHandler) | undefined,
): (connection: ReadyConnection) => AuthenticatedHandler | undefined {
  return (connection) => {
    const active = links.map((link) => link(connection)).filter((link) => link !== null)
    const inner = lanes?.(connection)
    if (active.length === 0) return inner
    return {
      handle(frame, caps) {
        if (active.some((link) => link.handle(frame, caps))) return
        if (inner) inner.handle(frame, caps)
        else refuseFrame(connection.socket, frame)
      },
      renew(caps) {
        for (const link of active) link.renew?.(caps)
        inner?.renew(caps)
      },
      close() {
        for (const link of active) link.close?.()
        inner?.close()
      },
    }
  }
}
