import type { FrameSocket } from '@shared/host-protocol'

/** No socket or credentials ever cross preload. Opening has a bounded deadline. */
export function openHostSocket(url: string): Promise<FrameSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('offline'))
    }, 10_000)
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('offline'))
    })
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      resolve({
        send: (text) => ws.send(text),
        close: (code, reason) => ws.close(code, reason),
        onMessage: (cb) =>
          ws.addEventListener('message', (event) => {
            if (typeof event.data !== 'string') ws.close(4400, 'Bad frame')
            else cb(event.data)
          }),
        onClose: (cb) => ws.addEventListener('close', (event) => cb(event.code, '')),
        isOpen: () => ws.readyState === WebSocket.OPEN,
        bufferedBytes: () => ws.bufferedAmount,
      })
    })
  })
}
