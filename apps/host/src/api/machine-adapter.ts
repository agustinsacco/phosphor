import { sendFrame, type FrameLinkFactory } from './adapter'

/**
 * Another machine's agent reaches this Host only through `ops.run`, which the
 * ops link answers ahead of this one. Everything else a machine grant sends
 * is refused here, before the lane adapter.
 */
export function createMachineAdapter(): FrameLinkFactory {
  return (connection) => {
    if (connection.principal?.kind !== 'grant-machine') return null
    const { socket } = connection
    return {
      handle(frame) {
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
            error: { code: 'forbidden', message: 'forbidden' },
          })
        else if (frame.type === 'terminal.input')
          sendFrame(socket, {
            type: 'terminal.ack',
            terminalId: frame.terminalId,
            seq: frame.seq,
            accepted: false,
          })
        return true
      },
    }
  }
}
