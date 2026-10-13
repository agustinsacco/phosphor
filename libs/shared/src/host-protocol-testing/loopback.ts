import { HOST_LIMITS, utf8Length, type FrameSocket } from '../host-protocol'

export interface LoopbackOptions {
  inboundFrameBytes?: number
  outboundFrameBytes?: number
  queueBytes?: number
}

/** Test transport: even paused traffic has a byte cap, and never runs inline. */
export function createLoopbackPair(options: LoopbackOptions = {}) {
  function limit(value: number | undefined, maximum: number): number {
    if (value === undefined) return maximum
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
      throw new Error('Invalid loopback limit')
    return value
  }
  const inbound = limit(options.inboundFrameBytes, HOST_LIMITS.inboundFrameBytes)
  const outbound = limit(options.outboundFrameBytes, HOST_LIMITS.outboundFrameBytes)
  const cap = limit(options.queueBytes, HOST_LIMITS.sendQueueBytes)
  let open = true,
    paused = false,
    dropped = 0,
    queuedBytes = 0,
    scheduled = false
  const queue: { to: number; text: string; bytes: number }[] = []
  const messages: ((text: string) => void)[][] = [[], []]
  const closes: ((code: number, reason: string) => void)[][] = [[], []]
  function close(code: number, reason: string) {
    if (!open) return
    open = false
    queue.length = 0
    queuedBytes = 0
    queueMicrotask(() => {
      for (const side of closes) for (const cb of side) cb(code, reason)
    })
  }
  function flush() {
    scheduled = false
    if (paused || !open) return
    while (queue.length && !paused && open) {
      const next = queue.shift()
      if (!next) break
      queuedBytes -= next.bytes
      for (const cb of messages[next.to] ?? []) cb(next.text)
    }
  }
  function schedule() {
    if (!scheduled) {
      scheduled = true
      queueMicrotask(flush)
    }
  }
  function socket(side: number): FrameSocket {
    return {
      send(text) {
        if (!open) throw new Error('Socket closed')
        const bytes = utf8Length(text)
        if (side === 1 && bytes > outbound) throw new Error('Outbound frame too large')
        if (side === 0 && bytes > inbound) {
          close(4400, 'Frame too large')
          return
        }
        if (dropped > 0) {
          dropped--
          return
        }
        if (queuedBytes + bytes > cap) {
          close(4429, 'Transport queue full')
          return
        }
        queue.push({ to: 1 - side, text, bytes })
        queuedBytes += bytes
        schedule()
      },
      close,
      onMessage(cb) {
        messages[side]?.push(cb)
      },
      onClose(cb) {
        closes[side]?.push(cb)
      },
      isOpen: () => open,
      bufferedBytes: () =>
        queue.filter((q) => q.to === 1 - side).reduce((sum, q) => sum + q.bytes, 0),
    }
  }
  return {
    client: socket(0),
    server: socket(1),
    pause() {
      paused = true
    },
    resume() {
      paused = false
      schedule()
    },
    dropNext(n = 1) {
      if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid drop count')
      dropped = n
    },
    sever() {
      close(1006, 'Severed')
    },
  }
}
