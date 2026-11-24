import { chmod } from 'node:fs/promises'
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'

// The extension caps text at 2M JS characters. Allow for its JSON envelope and UTF-8.
const BODY_LIMIT = 8 * 1024 * 1024

async function readBody(message: IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of message.iterator({ destroyOnReturn: false })) {
    const bytes = chunk as Buffer
    size += bytes.length
    if (size > limit) return null
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, size)
}

function reply(res: ServerResponse, status: number, body?: Buffer): void {
  res.shouldKeepAlive = false
  res.writeHead(status, { 'content-type': 'application/json' }).end(body)
}

async function forward(
  req: IncomingMessage,
  res: ServerResponse,
  livePort: () => number | undefined,
  limit: number,
): Promise<void> {
  const health = req.url === '/health' && req.method === 'GET'
  if (!health && !(req.url === '/v1/compress' && req.method === 'POST')) return reply(res, 404)
  if (!livePort()) return reply(res, 503)
  const max = health ? 0 : limit
  if (Number(req.headers['content-length']) > max) return reply(res, 413)
  const body = await readBody(req, max)
  if (!body) return reply(res, 413)
  // A slow upload can outlive the child. Look up its proved port again immediately before use.
  const port = livePort()
  if (!port) return reply(res, 503)
  const abort = new AbortController()
  res.once('close', () => abort.abort())
  const upstream = await new Promise<IncomingMessage>((resolve, reject) => {
    const pending = request(
      {
        hostname: '127.0.0.1',
        port,
        method: req.method,
        path: req.url,
        agent: false,
        headers: health
          ? {}
          : { 'content-type': 'application/json', 'content-length': body.length },
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
      },
      resolve,
    )
    pending.on('error', reject)
    pending.end(body)
  })
  try {
    const result = await readBody(upstream, limit)
    if (!result || livePort() !== port) return reply(res, 503)
    reply(res, upstream.statusCode ?? 503, result)
  } finally {
    upstream.destroy()
  }
}

/** The caller has verified the private socket folder and holds the daemon run lock. */
export async function startHeadroomRelay(
  socketPath: string,
  livePort: () => number | undefined,
  limit = BODY_LIMIT,
) {
  const server = createServer(
    { requestTimeout: 10_000, connectionsCheckingInterval: 1000 },
    (req, res) => {
      void forward(req, res, livePort, limit).catch(() => reply(res, 503))
    },
  )
  server.maxConnections = 16
  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  try {
    await chmod(socketPath, 0o600)
  } catch (error) {
    await close()
    throw error
  }
  return { close }
}
