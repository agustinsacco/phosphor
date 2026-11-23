import { randomBytes } from 'node:crypto'
import { request } from 'node:http'
import { WebSocket } from 'ws'
import { HOST_API_ROUTES, type HostFrame } from '@phosphor/shared/host-protocol'

/** One HTTP GET over a Unix socket: status and parsed JSON body (or null). */
export function socketGet(
  socketPath: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: 'GET', headers }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString()
        let body: unknown = null
        try {
          body = text ? JSON.parse(text) : null
        } catch {
          body = text
        }
        resolve({ status: response.statusCode ?? 0, body })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

/** The socket's hello for a fresh challenge: `{hello, proof, nonce}`. */
export async function socketHello(socketPath: string) {
  const challenge = randomBytes(32).toString('hex')
  const answer = await socketGet(socketPath, `${HOST_API_ROUTES.hello}?challenge=${challenge}`)
  return { challenge, ...answer }
}

/** A WebSocket client on the socket's stream route that records every frame it receives. */
export function socketStream(socketPath: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(`ws+unix:${socketPath}:${HOST_API_ROUTES.stream}`, { headers })
  const frames: HostFrame[] = []
  let closed: { code: number } | null = null
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
    ws.once('unexpected-response', (_request, response) =>
      reject(new Error(`HTTP ${response.statusCode}`)),
    )
  })
  ws.on('message', (data) => frames.push(JSON.parse(String(data)) as HostFrame))
  ws.on('close', (code) => {
    closed = { code }
  })
  return {
    opened,
    frames,
    closed: () => closed,
    send: (frame: unknown) => ws.send(JSON.stringify(frame)),
    close: () => ws.terminate(),
  }
}
