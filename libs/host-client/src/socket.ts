import { HOST_LIMITS, type FrameSocket } from '@phosphor/shared/host-protocol'
import type { TraceLog } from './ports'

/** Browser and native WHATWG WebSockets share bounded opening and frame handling. */
export function openHostSocket(url: string, log: TraceLog = () => {}): Promise<FrameSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const encoder = new TextEncoder()
    const close = (code = 1000, reason = '') => {
      let bounded = ''
      for (const char of reason) {
        if (encoder.encode(bounded + char).length > 123) break
        bounded += char
      }
      try {
        ws.close(
          code === 1000 || (Number.isInteger(code) && code >= 3000 && code <= 4999) ? code : 1000,
          bounded,
        )
      } catch {
        log('hosts', 'close_failed')
      }
    }
    const timer = setTimeout(fail, 10_000)
    function cleanup() {
      clearTimeout(timer)
      ws.removeEventListener('open', opened)
      ws.removeEventListener('close', fail)
      ws.removeEventListener('error', fail)
    }
    function fail() {
      cleanup()
      close()
      reject(new Error('offline'))
    }
    function opened() {
      cleanup()
      ws.addEventListener('error', () => close())
      resolve({
        send: (text) => ws.send(text),
        close,
        onMessage: (cb) =>
          ws.addEventListener('message', (event) => {
            if (
              typeof event.data !== 'string' ||
              encoder.encode(event.data).length > HOST_LIMITS.outboundFrameBytes
            )
              close(4400, 'Bad frame')
            else cb(event.data)
          }),
        onClose: (cb) => ws.addEventListener('close', (event) => cb(event.code, '')),
        isOpen: () => ws.readyState === WebSocket.OPEN,
        bufferedBytes: () => ws.bufferedAmount,
      })
    }
    ws.addEventListener('error', fail)
    ws.addEventListener('close', fail)
    ws.addEventListener('open', opened)
  })
}
