import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  BrainAgentMethod,
  BrainAgentRequest,
  BrainAgentResponse,
} from '@phosphor/shared/brain'

export interface BrainCapability {
  kind: 'working' | 'processor'
  scope: string
  policyEpoch: number
  sessionId?: string
  jobId?: string
  fence?: number
}
export interface BrainBridgeRuntime {
  allowed: (capability: BrainCapability) => Promise<boolean>
  invoke: (
    capability: BrainCapability,
    method: BrainAgentMethod,
    params: unknown,
    signal: AbortSignal,
  ) => Promise<unknown>
}
const MAX_BYTES = 512 * 1024
const METHODS = {
  working: new Set<BrainAgentMethod>(['search', 'read', 'brief']),
  processor: new Set<BrainAgentMethod>(['job', 'propose']),
}
const digest = (token: string): string => createHash('sha256').update(token).digest('hex')

/** Private local transport, never HTTP/TCP. Capabilities narrow authority; payloads cannot widen it. */
export async function createBrainBridge(runtime: BrainBridgeRuntime) {
  const directory = await mkdtemp(join(tmpdir(), 'ph-brain-'))
  await chmod(directory, 0o700)
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\phosphor-brain-${randomBytes(12).toString('hex')}`
      : join(directory, 'rpc.sock')
  const grants = new Map<string, BrainCapability>()
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    if (sockets.size >= 32) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    accept(socket, grants, runtime)
    socket.once('close', () => sockets.delete(socket))
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
    issue(capability: BrainCapability) {
      if (grants.size >= 512) throw new Error('Brain connection capacity reached')
      const token = randomBytes(32).toString('hex')
      const key = digest(token)
      const grant = { ...capability }
      grants.set(key, grant)
      return {
        connection: { endpoint, token },
        bind(sessionId: string) {
          grant.sessionId = sessionId
        },
        revoke() {
          grants.delete(key)
        },
      }
    },
    revokeAll() {
      grants.clear()
    },
    async close() {
      grants.clear()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    },
  }
}

function accept(socket: Socket, grants: Map<string, BrainCapability>, runtime: BrainBridgeRuntime) {
  const abort = new AbortController()
  let buffer = Buffer.alloc(0)
  let handled = false
  socket.setTimeout(15_000, () => socket.destroy())
  socket.on('error', () => socket.destroy())
  socket.once('close', () => abort.abort())
  socket.on('data', (chunk: Buffer) => {
    if (handled) {
      socket.destroy()
      return
    }
    if (buffer.length + chunk.length > MAX_BYTES) {
      socket.destroy()
      return
    }
    buffer = Buffer.concat([buffer, chunk])
    const newline = buffer.indexOf(10)
    if (newline < 0) return
    handled = true
    // Exactly one request, never a pipeline of privileged operations.
    if (newline !== buffer.length - 1) {
      socket.destroy()
      return
    }
    const request = buffer.subarray(0, newline).toString('utf8')
    buffer = Buffer.alloc(0)
    void respond(request, grants, runtime, abort.signal)
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
  grants: Map<string, BrainCapability>,
  runtime: BrainBridgeRuntime,
  signal: AbortSignal,
): Promise<BrainAgentResponse> {
  const denied: BrainAgentResponse = { ok: false, error: 'Brain request unavailable' }
  try {
    const input = JSON.parse(text) as Partial<BrainAgentRequest> | null
    if (
      !input ||
      input.version !== 1 ||
      typeof input.token !== 'string' ||
      !/^[a-f0-9]{64}$/.test(input.token)
    )
      return denied
    const key = digest(input.token)
    const grant = grants.get(key)
    if (!grant || !input.method || !METHODS[grant.kind].has(input.method)) return denied
    if (!(await runtime.allowed(grant)) || signal.aborted || grants.get(key) !== grant)
      return denied
    const data = await runtime.invoke({ ...grant }, input.method, input.params, signal)
    // Revocation while awaiting disk/inference suppresses the result as well.
    if (signal.aborted || grants.get(key) !== grant || !(await runtime.allowed(grant)))
      return denied
    return { ok: true, data }
  } catch {
    // Never disclose a path, credential or another scope's existence in an error.
    return denied
  }
}
