import { HOST_LIMITS, type HostFrame, type Receipt } from '@phosphor/shared/host-protocol'
import type { HostCapability } from '@phosphor/shared/remote-host'
import type { LaneService } from '../lanes/service'
import { createSubscriptions } from '../lanes/subscriptions'
import { streamLimits, type StreamLimits } from '../lanes/stream'
import type { ApiLog, AuthenticatedHandler, ReadyConnection } from './connection'

export function createLaneAdapter(
  service: LaneService,
  options: {
    limits?: Partial<StreamLimits> & { pendingCommandsPerConnection?: number }
    log?: ApiLog
  } = {},
) {
  const { pendingCommandsPerConnection = HOST_LIMITS.pendingCommandsPerConnection, ...input } =
    options.limits ?? {}
  if (
    !Number.isSafeInteger(pendingCommandsPerConnection) ||
    pendingCommandsPerConnection < 1 ||
    pendingCommandsPerConnection > HOST_LIMITS.pendingCommandsPerConnection
  )
    throw new Error('Invalid pending limit')
  const limits = streamLimits(input)
  type Peer = {
    clientId: string
    reply(receipt: Receipt): void
    interested(requestId: string): boolean
  }
  const peers = new Map<string, Peer>()
  const clients = new Map<string, Set<string>>()
  function handler(connection: ReadyConnection): AuthenticatedHandler {
    const { socket, connectionId, client } = connection
    let caps = connection.caps
    let closed = false
    let inFlight = 0
    const pending = new Set<string>()
    const interests = new Map<string, 'command' | 'status'>()
    let subscriptions: ReturnType<typeof createSubscriptions> | undefined
    function close() {
      if (closed) return
      closed = true
      subscriptions?.close()
      subscriptions = undefined
      pending.clear()
      interests.clear()
      peers.delete(connectionId)
      const sockets = clients.get(client.id)
      sockets?.delete(connectionId)
      if (sockets?.size === 0) {
        clients.delete(client.id)
        service.controllerPresence(client.id)
      }
    }
    function stop() {
      close()
      socket.close(4429, '4429')
    }
    function send(frame: HostFrame) {
      if (closed || !socket.isOpen()) return
      try {
        const text = JSON.stringify(frame)
        const bytes = Buffer.byteLength(text)
        if (
          bytes > limits.outboundFrameBytes ||
          socket.bufferedBytes() + bytes > limits.sendQueueBytes
        )
          return stop()
        socket.send(text)
      } catch {
        stop()
      }
    }
    function interest(requestId: string, kind: 'command' | 'status') {
      if (interests.get(requestId) === 'command') return
      interests.delete(requestId)
      interests.set(requestId, kind)
      if (interests.size > 2 * pendingCommandsPerConnection) {
        for (const [id, value] of interests) {
          if (value === 'status') {
            interests.delete(id)
            break
          }
        }
      }
    }
    function reply(receipt: Receipt) {
      send({ type: 'receipt', receipt })
      // A conflicting attempt does not settle the original command's interest.
      if (
        receipt.status !== 'pending' &&
        !(receipt.status === 'rejected' && receipt.code === 'conflict')
      ) {
        interests.delete(receipt.requestId)
        pending.delete(receipt.requestId)
      }
    }
    function renew(next: readonly HostCapability[]) {
      caps = next
      if (!caps.includes('sessions.read')) {
        subscriptions?.close()
        subscriptions = undefined
      } else if (!subscriptions && !closed) {
        // The adapter owns close. Renewals must not accumulate socket listeners.
        subscriptions = createSubscriptions(
          { ...socket, onClose: () => {} },
          service.streams,
          service.lanesTopic,
          limits,
          (event, data) =>
            options.log?.(event, {
              topic: data.topic,
              code: data.code,
              ...(data.trace ? { trace: data.trace } : {}),
            }),
        )
      }
    }
    peers.set(connectionId, { clientId: client.id, reply, interested: (id) => interests.has(id) })
    const sockets = clients.get(client.id) ?? new Set<string>()
    clients.set(client.id, sockets)
    sockets.add(connectionId)
    renew(caps)
    if (sockets.size === 1) service.controllerPresence(client.id)
    socket.onClose(close)
    return {
      close,
      renew,
      handle(frame) {
        if (closed || !socket.isOpen()) return
        if (frame.type === 'subscribe' || frame.type === 'unsubscribe') {
          if (subscriptions) subscriptions.handle(frame)
          else if (frame.type === 'subscribe')
            send({ type: 'subscribe-failed', id: frame.id, code: 'forbidden' })
        } else if (frame.type === 'receipt-status') {
          interest(frame.requestId, 'status')
          try {
            service.commands.status(client.id, frame.requestId, connectionId)
          } catch {
            stop()
          }
        } else if (frame.type === 'command') {
          if (!caps.includes('sessions.control'))
            return send({
              type: 'receipt',
              receipt: {
                requestId: frame.requestId,
                status: 'rejected',
                code: 'forbidden',
              },
            })
          if (!pending.has(frame.requestId) && pending.size >= pendingCommandsPerConnection)
            return send({
              type: 'receipt',
              receipt: {
                requestId: frame.requestId,
                status: 'rejected',
                code: 'too-many-requests',
              },
            })
          pending.add(frame.requestId)
          interest(frame.requestId, 'command')
          const sender = { id: client.id, label: client.label, caps, connectionId }
          void (async () => {
            try {
              await service.commands.submit(sender, frame)
            } catch {
              // No retry or invented failure: execution may already have acted.
              stop()
            }
          })()
        } else if (frame.type === 'call') {
          if (!caps.includes('sessions.read'))
            return send({
              type: 'result',
              id: frame.id,
              ok: false,
              error: { code: 'forbidden', message: 'forbidden' },
            })
          if (inFlight >= pendingCommandsPerConnection) return stop()
          inFlight++
          void (async () => {
            try {
              const outcome = await service.calls.call(frame.method, frame.params)
              if (closed || !socket.isOpen() || !caps.includes('sessions.read')) return
              const result: HostFrame = { type: 'result', id: frame.id, ...outcome }
              if (Buffer.byteLength(JSON.stringify(result)) > limits.outboundFrameBytes)
                send({
                  type: 'result',
                  id: frame.id,
                  ok: false,
                  error: { code: 'too-large', message: 'too-large' },
                })
              else send(result)
            } catch {
              if (!closed && socket.isOpen() && caps.includes('sessions.read'))
                send({
                  type: 'result',
                  id: frame.id,
                  ok: false,
                  error: { code: 'internal', message: 'internal' },
                })
            } finally {
              inFlight--
            }
          })()
        }
      },
    }
  }
  return {
    handler,
    isConnected: (clientId: string) => (clients.get(clientId)?.size ?? 0) > 0,
    deliver(clientId: string, receipt: Receipt, connectionId?: string) {
      if (connectionId !== undefined) {
        const peer = peers.get(connectionId)
        if (peer?.clientId === clientId) peer.reply(receipt)
      } else {
        for (const id of clients.get(clientId) ?? []) {
          const peer = peers.get(id)
          if (peer?.interested(receipt.requestId)) peer.reply(receipt)
        }
      }
    },
  }
}
