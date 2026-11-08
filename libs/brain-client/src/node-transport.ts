import { createConnection } from 'node:net'
import { posix } from 'node:path'
import {
  BRAIN_PROTOCOL,
  type BrainAgentMap,
  type BrainAgentMethod,
  type BrainAgentRequest,
} from '@phosphor/shared/brain'
import { BrainClientError } from './client'
import type { BrainConnection, BrainTransport } from './port'

/** One LF-terminated JSON frame per direction, the LF included. */
export const BRAIN_MAX_FRAME_BYTES = 512 * 1024
export const BRAIN_DEFAULT_TIMEOUT_MS = 10_000
export const BRAIN_ENDPOINT_ENV = 'PHOSPHOR_BRAIN_ENDPOINT'
export const BRAIN_TOKEN_ENV = 'PHOSPHOR_BRAIN_TOKEN'

const LF = 0x0a
const MAX_TOKEN_CHARS = 4096
const MAX_REMOTE_ERROR_CHARS = 500
/** Local pipes only: `\\server\pipe\…` would reach another machine. */
const WINDOWS_LOCAL_PIPE = /^\\\\\.\\pipe\\[^\0/]{1,240}$/
const TOKEN_SHAPE = /^[\x21-\x7e]+$/

export interface NodeBrainTransportOptions {
  timeoutMs?: number
  platform?: NodeJS.Platform
}

/** A Unix socket path or a local Windows named pipe; never a host, port or URL. */
export function isBrainEndpoint(endpoint: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return WINDOWS_LOCAL_PIPE.test(endpoint)
  return posix.isAbsolute(endpoint) && !endpoint.includes('\0') && !endpoint.includes('\n')
}

function isBrainToken(token: string): boolean {
  return token.length <= MAX_TOKEN_CHARS && TOKEN_SHAPE.test(token)
}

/** Both variables or nothing: a half-configured session is treated as Brain-less. */
export function brainConnectionFromEnv(env: NodeJS.ProcessEnv): BrainConnection | null {
  const endpoint = env[BRAIN_ENDPOINT_ENV]
  const token = env[BRAIN_TOKEN_ENV]
  if (!endpoint || !token) return null
  return { endpoint, token }
}

export function createNodeBrainTransport(
  connection: BrainConnection,
  options: NodeBrainTransportOptions = {},
): BrainTransport {
  const { endpoint, token } = connection
  if (!isBrainEndpoint(endpoint, options.platform ?? process.platform)) {
    throw new BrainClientError(
      'invalid_connection',
      'Brain endpoint must be a local socket or pipe',
    )
  }
  if (!isBrainToken(token)) {
    throw new BrainClientError('invalid_connection', 'Brain capability token is malformed')
  }
  const timeoutMs = options.timeoutMs ?? BRAIN_DEFAULT_TIMEOUT_MS
  return {
    async request<M extends BrainAgentMethod>(
      method: M,
      params: BrainAgentMap[M]['request'],
      signal?: AbortSignal,
    ): Promise<BrainAgentMap[M]['result']> {
      const frame = encodeRequest({ version: BRAIN_PROTOCOL, token, method, params })
      const line = await exchange(endpoint, frame, timeoutMs, signal)
      return decodeResponse(line, token) as BrainAgentMap[M]['result']
    },
  }
}

function encodeRequest(request: BrainAgentRequest): Buffer {
  let text: string
  try {
    text = JSON.stringify(request)
  } catch {
    throw new BrainClientError('malformed', `Brain ${request.method} request could not be encoded`)
  }
  const frame = Buffer.from(`${text}\n`, 'utf8')
  if (frame.length > BRAIN_MAX_FRAME_BYTES) {
    throw new BrainClientError('oversized', `Brain ${request.method} request exceeds 512 KiB`)
  }
  return frame
}

function abortError(signal: AbortSignal): BrainClientError {
  const reason: unknown = signal.reason
  const timedOut = reason instanceof Error && reason.name === 'TimeoutError'
  return timedOut
    ? new BrainClientError('timeout', 'Brain request timed out')
    : new BrainClientError('aborted', 'Brain request was cancelled')
}

/** One request per connection: write a frame, read up to the first LF, close. */
function exchange(
  endpoint: string,
  frame: Buffer,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal))
      return
    }
    const socket = createConnection({ path: endpoint })
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const settle = (error: BrainClientError | null, line?: Buffer): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      socket.destroy()
      if (error) reject(error)
      else resolve(line!)
    }
    const onAbort = (): void => settle(abortError(signal!))
    const timer = setTimeout(
      () => settle(new BrainClientError('timeout', `Brain request timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
    signal?.addEventListener('abort', onAbort, { once: true })
    socket.on('connect', () => socket.write(frame))
    socket.on('data', (chunk: Buffer) => {
      const end = chunk.indexOf(LF)
      const part = end === -1 ? chunk : chunk.subarray(0, end)
      size += part.length
      if (size >= BRAIN_MAX_FRAME_BYTES) {
        settle(new BrainClientError('oversized', 'Brain response exceeds 512 KiB'))
        return
      }
      chunks.push(part)
      if (end !== -1) settle(null, Buffer.concat(chunks, size))
    })
    const closed = (): void =>
      settle(new BrainClientError('malformed', 'Brain closed the connection without a response'))
    socket.on('end', closed)
    socket.on('close', closed)
    socket.on('error', (error: NodeJS.ErrnoException) => {
      const code = typeof error.code === 'string' ? ` (${error.code})` : ''
      settle(new BrainClientError('connection', `Brain connection failed${code}`))
    })
  })
}

/** Remote text reaches the model and logs: one bounded line, never the token. */
function redact(message: string, token: string): string {
  const printable = Array.from(message.split(token).join('[redacted]'), (char) => {
    const code = char.charCodeAt(0)
    return code < 0x20 || code === 0x7f ? ' ' : char
  })
  return printable.join('').slice(0, MAX_REMOTE_ERROR_CHARS)
}

function decodeResponse(line: Buffer, token: string): unknown {
  let response: unknown
  try {
    response = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line))
  } catch {
    throw new BrainClientError('malformed', 'Brain response is not valid JSON')
  }
  if (typeof response !== 'object' || response === null || Array.isArray(response)) {
    throw new BrainClientError('malformed', 'Brain response is not an object')
  }
  const envelope = response as Record<string, unknown>
  if (envelope.ok === true && Object.hasOwn(envelope, 'data')) return envelope.data
  if (envelope.ok === false && typeof envelope.error === 'string') {
    throw new BrainClientError('remote', redact(envelope.error, token) || 'Brain request failed')
  }
  throw new BrainClientError('malformed', 'Brain response envelope is invalid')
}
