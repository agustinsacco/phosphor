import { HOST_LIMITS, type HostFrame, type FrameSocket } from '@phosphor/shared/host-protocol'
import { streamLimits, type StreamLimits } from '../lanes/stream'
import type { ApiLog } from './connection'

export function laneLimits(
  input?: Partial<StreamLimits> & { pendingCommandsPerConnection?: number },
) {
  const { pendingCommandsPerConnection = HOST_LIMITS.pendingCommandsPerConnection, ...stream } =
    input ?? {}
  if (
    !Number.isSafeInteger(pendingCommandsPerConnection) ||
    pendingCommandsPerConnection < 1 ||
    pendingCommandsPerConnection > HOST_LIMITS.pendingCommandsPerConnection
  )
    throw new Error('Invalid pending limit')
  return { pendingCommandsPerConnection, limits: streamLimits(stream) }
}

/** The adapter owns lifetime; the transport owns bounded encoding and diagnostic projection. */
export function createLaneSender(ports: {
  socket: FrameSocket
  limits: StreamLimits
  closed(): boolean
  stop(): void
  log?: ApiLog
  traceFields: Record<string, string>
}) {
  return (frame: HostFrame): void => {
    if (ports.closed() || !ports.socket.isOpen()) return
    try {
      const text = JSON.stringify(frame)
      const bytes = Buffer.byteLength(text)
      if (
        bytes > ports.limits.outboundFrameBytes ||
        ports.socket.bufferedBytes() + bytes > ports.limits.sendQueueBytes
      )
        return ports.stop()
      ports.socket.send(text)
      if (frame.type === 'receipt')
        ports.log?.('api.receipt', { ...ports.traceFields, status: frame.receipt.status })
    } catch {
      ports.stop()
    }
  }
}
