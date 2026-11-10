import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BRAIN_PROTOCOL,
  type BrainAgentMethod,
  type BrainAgentResponse,
} from '@phosphor/shared/brain'
import { validateBrainRequest } from '@phosphor/brain-client/validate'

const MAX_BYTES = 512 * 1024
export type BridgeInvoke = (method: BrainAgentMethod, params: unknown) => Promise<unknown>

/** One random read-only token per service lifetime, carried only over a private local socket. */
export async function createBrainBridge(invoke: BridgeInvoke) {
  const directory = await mkdtemp(join(tmpdir(), 'ph-brain-'))
  await chmod(directory, 0o700)
  const token = randomBytes(32).toString('hex')
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\phosphor-brain-${randomBytes(12).toString('hex')}`
      : join(directory, 'rpc.sock')
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    if (sockets.size >= 32) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    accept(socket, token, invoke)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(endpoint, () => {
        server.off('error', reject)
        resolve()
      })
    })
    if (process.platform !== 'win32') await chmod(endpoint, 0o600)
  } catch (error) {
    server.close()
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  return {
    endpoint,
    token,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    },
  }
}

function accept(socket: Socket, token: string, invoke: BridgeInvoke): void {
  let buffer = Buffer.alloc(0)
  let handled = false
  socket.setTimeout(15_000, () => socket.destroy())
  socket.on('error', () => socket.destroy())
  socket.on('data', (chunk: Buffer) => {
    if (handled || buffer.length + chunk.length > MAX_BYTES) {
      socket.destroy()
      return
    }
    buffer = Buffer.concat([buffer, chunk])
    const newline = buffer.indexOf(10)
    if (newline < 0) return
    handled = true
    if (newline !== buffer.length - 1) {
      socket.destroy()
      return
    }
    const text = buffer.subarray(0, newline).toString('utf8')
    buffer = Buffer.alloc(0)
    respond(text, token, invoke)
      .then((response) => {
        if (socket.destroyed) return
        const body = JSON.stringify(response)
        socket.end(
          Buffer.byteLength(body) <= MAX_BYTES
            ? `${body}\n`
            : '{"ok":false,"error":"Brain response exceeds limit"}\n',
        )
      })
      .catch(() => socket.destroy())
  })
}

async function respond(
  text: string,
  token: string,
  invoke: BridgeInvoke,
): Promise<BrainAgentResponse> {
  try {
    const input = JSON.parse(text) as {
      version?: unknown
      token?: unknown
      method?: unknown
      params?: unknown
    } | null
    if (
      !input ||
      input.version !== BRAIN_PROTOCOL ||
      typeof input.token !== 'string' ||
      input.token.length !== token.length ||
      !timingSafeEqual(Buffer.from(input.token), Buffer.from(token)) ||
      input.method !== 'search'
    )
      throw new Error('Denied')
    const params = validateBrainRequest(input.method, input.params)
    return { ok: true, data: await invoke(input.method, params) }
  } catch {
    return { ok: false, error: 'Brain request unavailable' }
  }
}
