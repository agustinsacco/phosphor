import type { FrameSocket } from '@shared/host-protocol'
import type { TraceLog } from '../control/observations'

/** Only a dev Desktop may reach the disposable loopback Host. */
export function e2eHostEndpoint(env: NodeJS.ProcessEnv, packaged: boolean): string | undefined {
  if (packaged) return undefined
  const value = env.PHOSPHOR_E2E_HOST_ENDPOINT
  const match = /^https:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})$/.exec(value ?? '')
  return match && Number(match[1]) >= 1024 && Number(match[1]) <= 65535 ? value : undefined
}

export function hostSocketUrl(url: string, testEndpoint?: string): string {
  return testEndpoint && url === `${testEndpoint.replace('https:', 'wss:')}/v1/stream`
    ? url.replace('wss:', 'ws:')
    : url
}

/** No socket or credentials ever cross preload. Opening has a bounded deadline. */
export function openHostSocket(
  url: string,
  log: TraceLog = () => {},
  testEndpoint?: string,
): Promise<FrameSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(hostSocketUrl(url, testEndpoint))
    const close = (code = 1000, reason = '') => {
      let bounded = ''
      for (const char of reason) {
        if (Buffer.byteLength(bounded + char) > 123) break
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
    const timer = setTimeout(() => {
      close()
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
        close,
        onMessage: (cb) =>
          ws.addEventListener('message', (event) => {
            if (typeof event.data !== 'string') close(4400, 'Bad frame')
            else cb(event.data)
          }),
        onClose: (cb) => ws.addEventListener('close', (event) => cb(event.code, '')),
        isOpen: () => ws.readyState === WebSocket.OPEN,
        bufferedBytes: () => ws.bufferedAmount,
      })
    })
  })
}
