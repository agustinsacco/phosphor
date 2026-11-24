import { request } from 'node:http'
import { WebSocket } from 'ws'
import { HOST_API_ROUTES, HOST_LIMITS, type FrameSocket } from '@phosphor/shared/host-protocol'
import { localHelloNonce } from '@phosphor/shared/host-local'

const HELLO_TIMEOUT_MS = 10_000
const OPEN_TIMEOUT_MS = 10_000
const HELLO_MAX_BYTES = 64 * 1024

/** `GET /v1/hello` on the socket: the hello's host id and a single-use nonce. */
export function fetchSocketHello(
  socketPath: string,
  challenge: string,
): Promise<{ hostId: string; nonce: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: `${HOST_API_ROUTES.hello}?challenge=${challenge}`,
        method: 'GET',
        timeout: HELLO_TIMEOUT_MS,
      },
      (response) => {
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > HELLO_MAX_BYTES) req.destroy(new Error('offline'))
          else chunks.push(chunk)
        })
        response.on('error', () => reject(new Error('offline')))
        response.on('end', () => {
          let body: unknown
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            body = null
          }
          const nonce = localHelloNonce(body)
          const hello = (body as { hello?: { hostId?: unknown } } | null)?.hello
          if (response.statusCode !== 200 || !nonce || typeof hello?.hostId !== 'string')
            return reject(new Error(response.statusCode === 429 ? 'too-many-requests' : 'offline'))
          resolve({ hostId: hello.hostId, nonce })
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('offline')))
    req.on('error', () => reject(new Error('offline')))
    req.end()
  })
}

/** Close codes the `ws` client accepts from us; anything else closes normally. */
function closeCode(code: number): number {
  return code === 1000 || (Number.isInteger(code) && code >= 3000 && code <= 4999) ? code : 1000
}

/** A close reason within the 123 bytes a close frame carries. */
function boundedReason(reason: string): string {
  let bounded = ''
  for (const char of reason) {
    if (Buffer.byteLength(bounded + char) > 123) break
    bounded += char
  }
  return bounded
}

/**
 * The socket's stream route as a `FrameSocket`, the same bounded behaviour
 * as the browser socket in `@phosphor/host-client/socket`: text frames only,
 * none over `outboundFrameBytes`, a 10 s open deadline, and no `Origin` header.
 */
export function openLocalSocket(socketPath: string): Promise<FrameSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws+unix:${socketPath}:${HOST_API_ROUTES.stream}`, {
      maxPayload: HOST_LIMITS.outboundFrameBytes,
      perMessageDeflate: false,
      followRedirects: false,
      handshakeTimeout: OPEN_TIMEOUT_MS,
    })
    const close = (code = 1000, reason = '') => {
      try {
        ws.close(closeCode(code), boundedReason(reason))
      } catch {
        ws.terminate()
      }
    }
    const timer = setTimeout(fail, OPEN_TIMEOUT_MS)
    function fail() {
      clearTimeout(timer)
      ws.removeAllListeners()
      ws.on('error', () => {})
      ws.terminate()
      reject(new Error('offline'))
    }
    ws.once('error', fail)
    ws.once('unexpected-response', fail)
    ws.once('close', fail)
    ws.once('open', () => {
      clearTimeout(timer)
      ws.removeAllListeners()
      ws.on('error', () => close())
      resolve({
        send: (text) => ws.send(text),
        close,
        onMessage: (cb) =>
          ws.on('message', (data, binary) => {
            const text = !binary && Buffer.isBuffer(data) ? data.toString('utf8') : null
            if (text === null || Buffer.byteLength(text) > HOST_LIMITS.outboundFrameBytes)
              close(4400, 'Bad frame')
            else cb(text)
          }),
        onClose: (cb) => ws.on('close', (code) => cb(code, '')),
        isOpen: () => ws.readyState === WebSocket.OPEN,
        bufferedBytes: () => ws.bufferedAmount,
      })
    })
  })
}
