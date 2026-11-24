import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BRAIN_PROTOCOL,
  type BrainAgentMethod,
  type BrainAgentResponse,
  type BrainFlagResponse,
} from '@phosphor/shared/brain'
import { BRAIN_CURATOR_METHODS, BRAIN_LANE_METHODS } from '@phosphor/shared/brain-agent'
import { validateBrainRequest } from '@phosphor/brain-client/validate'
import { plainRefusal } from './agent/refusal'
import { chooseLocalSocket } from '@phosphor/shared/host-local'
import type { AppServiceRegistration } from '@phosphor/shared/host-protocol-owner'
import { brainFlagLimit } from './tidy/flag-limit'

const MAX_BYTES = 512 * 1024
/** Which token asked: any lane's, or the Brain lane's curator token. */
export type BridgeRole = 'lane' | 'curator'
type Role = BridgeRole
/** `signal` aborts when the asking socket closes. */
export type BridgeInvoke = (
  method: BrainAgentMethod,
  params: unknown,
  signal: AbortSignal,
  role: BridgeRole,
) => Promise<unknown>
interface Tokens {
  lane: string
  curator: string
}
const METHODS: Record<Role, ReadonlySet<string>> = {
  lane: new Set(BRAIN_LANE_METHODS),
  curator: new Set(BRAIN_CURATOR_METHODS),
}
const DENIED = { ok: false, error: 'Brain request unavailable' } as const

export interface BrainBridgeOptions {
  /** Until a request authenticates. */
  idleMs?: number
  /** Authenticated curator calls can take longer, such as embedding a corrected memory. */
  curatorIdleMs?: number
  /** Shared by both ingress paths in the Brain service process; tests inject their own. */
  flagLimit?: () => BrainFlagResponse | undefined
}

/**
 * Two random tokens per service lifetime, carried only over a private local socket: any lane's
 * token calls search and flag; the Brain lane's curator token calls Brain Agent's methods.
 */
export async function createBrainBridge(invoke: BridgeInvoke, options: BrainBridgeOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ph-brain-'))
  await chmod(directory, 0o700)
  const token = randomBytes(32).toString('hex')
  const curatorToken = randomBytes(32).toString('hex')
  const idle = { lane: options.idleMs ?? 15_000, curator: options.curatorIdleMs ?? 120_000 }
  const endpoint = join(directory, 'rpc.sock')
  const sockets = new Set<Socket>()
  const limit = options.flagLimit ?? brainFlagLimit
  const limitedInvoke: BridgeInvoke = async (method, params, signal, role) => {
    const refusal = method === 'flag' && limit()
    if (refusal) return refusal
    return invoke(method, params, signal, role)
  }
  const server = createServer((socket) => {
    if (sockets.size >= 32) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    accept(socket, { lane: token, curator: curatorToken }, limitedInvoke, idle)
  })
  try {
    if (!chooseLocalSocket([endpoint])) throw new Error('Brain socket path is too long.')
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(endpoint, () => {
        server.off('error', reject)
        resolve()
      })
    })
    await chmod(endpoint, 0o600)
  } catch (error) {
    server.close()
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  return {
    endpoint,
    token,
    registration: (recall: boolean): AppServiceRegistration => ({
      service: 'brain',
      endpoint,
      token,
      recall,
    }),
    curatorToken,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    },
  }
}

function accept(
  socket: Socket,
  tokens: Tokens,
  invoke: BridgeInvoke,
  idle: Record<Role, number>,
): void {
  let buffer = Buffer.alloc(0)
  let handled = false
  const closed = new AbortController()
  socket.setTimeout(idle.lane, () => socket.destroy())
  socket.once('close', () => closed.abort())
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
    const authenticated = (role: Role): void => {
      if (role === 'curator') socket.setTimeout(idle.curator)
    }
    respond(text, tokens, invoke, closed.signal, authenticated)
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

/** Compares against both tokens every time, in constant time. */
function roleOf(token: unknown, tokens: Tokens): Role | null {
  if (typeof token !== 'string') return null
  const given = Buffer.from(token)
  const matches = (expected: string): boolean => {
    const wanted = Buffer.from(expected)
    return given.length === wanted.length && timingSafeEqual(given, wanted)
  }
  const lane = matches(tokens.lane)
  const curator = matches(tokens.curator)
  return lane ? 'lane' : curator ? 'curator' : null
}

function authorize(
  text: string,
  tokens: Tokens,
): { role: Role; method: BrainAgentMethod; params: unknown } | null {
  try {
    const input = JSON.parse(text) as {
      version?: unknown
      token?: unknown
      method?: unknown
      params?: unknown
    } | null
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !['version', 'token', 'method', 'params'].includes(key)) ||
      input.version !== BRAIN_PROTOCOL
    )
      return null
    const role = roleOf(input.token, tokens)
    if (!role || typeof input.method !== 'string' || !METHODS[role].has(input.method)) return null
    return { role, method: input.method as BrainAgentMethod, params: input.params }
  } catch {
    return null
  }
}

/** Lane agents get one refusal for everything; Brain Agent learns why, in one plain line. */
async function respond(
  text: string,
  tokens: Tokens,
  invoke: BridgeInvoke,
  signal: AbortSignal,
  authenticated: (role: Role) => void,
): Promise<BrainAgentResponse> {
  const request = authorize(text, tokens)
  if (!request) return DENIED
  authenticated(request.role)
  try {
    const params = validateBrainRequest(request.method, request.params)
    return { ok: true, data: await invoke(request.method, params, signal, request.role) }
  } catch (error) {
    return request.role === 'lane'
      ? DENIED
      : { ok: false, error: plainRefusal(error, DENIED.error) }
  }
}
