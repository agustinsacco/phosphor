import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrainClientError } from './client'
import {
  BRAIN_MAX_FRAME_BYTES,
  brainConnectionFromEnv,
  createNodeBrainTransport,
  isBrainEndpoint,
} from './node-transport'

const TOKEN = 'cap-SECRET-token-123'
const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

/** A fake Brain socket: `respond` sees each raw request line and owns the reply. */
async function fakeBrain(
  respond: (socket: Socket, line: string) => void,
): Promise<{ endpoint: string; requests: string[] }> {
  const directory = mkdtempSync(join(tmpdir(), 'brain-'))
  const endpoint = join(directory, 's')
  const requests: string[] = []
  const sockets = new Set<Socket>()
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    let buffered = ''
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8')
      if (!buffered.includes('\n')) return
      requests.push(buffered)
      respond(socket, buffered)
    })
    socket.on('error', () => undefined)
  })
  await new Promise<void>((resolve) => server.listen(endpoint, resolve))
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy()
    server.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { endpoint, requests }
}

async function failure(promise: Promise<unknown>): Promise<BrainClientError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(BrainClientError)
  return error as BrainClientError
}

describe('createNodeBrainTransport', () => {
  it('sends one LF-terminated versioned request per connection and returns data', async () => {
    const brain = await fakeBrain((socket) =>
      socket.write('{"ok":true,"data":{"proposalId":"p1"}}\n'),
    )
    const transport = createNodeBrainTransport({ endpoint: brain.endpoint, token: TOKEN })

    await expect(transport.request('search', { query: 'Harbor' })).resolves.toEqual({
      proposalId: 'p1',
    })
    await transport.request('search', { query: 'Harbor' })

    expect(brain.requests).toHaveLength(2)
    expect(brain.requests[0]!.endsWith('\n')).toBe(true)
    expect(brain.requests[0]!.indexOf('\n')).toBe(brain.requests[0]!.length - 1)
    expect(JSON.parse(brain.requests[0]!)).toEqual({
      version: 4,
      token: TOKEN,
      method: 'search',
      params: { query: 'Harbor' },
    })
  })

  it('reassembles a response split across chunks, including a split UTF-8 sequence', async () => {
    const bytes = Buffer.from('{"ok":true,"data":"naïve – ✓"}\n', 'utf8')
    const brain = await fakeBrain((socket) => {
      socket.write(bytes.subarray(0, 21))
      setTimeout(() => socket.write(bytes.subarray(21)), 5)
    })
    const transport = createNodeBrainTransport({ endpoint: brain.endpoint, token: TOKEN })
    await expect(transport.request('search', { query: 'Harbor' })).resolves.toBe('naïve – ✓')
  })

  it('surfaces a remote error with the capability token redacted', async () => {
    const brain = await fakeBrain((socket) =>
      socket.write(`${JSON.stringify({ ok: false, error: `bad token ${TOKEN}\nnow` })}\n`),
    )
    const transport = createNodeBrainTransport({ endpoint: brain.endpoint, token: TOKEN })
    const error = await failure(transport.request('search', { query: 'q' }))
    expect(error.code).toBe('remote')
    expect(error.message).toBe('bad token [redacted] now')
  })

  it.each([
    ['not json', 'nope\n'],
    ['an array', '[1]\n'],
    ['a missing data field', '{"ok":true}\n'],
    ['a non-string error', '{"ok":false,"error":{"stack":"x"}}\n'],
    ['invalid UTF-8', Buffer.from([0x7b, 0xff, 0x7d, 0x0a])],
  ])('rejects %s as malformed', async (_label, reply) => {
    const brain = await fakeBrain((socket) => socket.write(reply))
    const transport = createNodeBrainTransport({ endpoint: brain.endpoint, token: TOKEN })
    expect((await failure(transport.request('search', { query: 'Harbor' }))).code).toBe('malformed')
  })

  it('rejects a connection that closes before a full line', async () => {
    const brain = await fakeBrain((socket) => socket.end('{"ok":true'))
    const transport = createNodeBrainTransport({ endpoint: brain.endpoint, token: TOKEN })
    expect((await failure(transport.request('search', { query: 'Harbor' }))).code).toBe('malformed')
  })

  it('stops reading a response at 512 KiB without an LF', async () => {
    const brain = await fakeBrain((socket) =>
      socket.write(Buffer.alloc(BRAIN_MAX_FRAME_BYTES, 0x20)),
    )
    const transport = createNodeBrainTransport({ endpoint: brain.endpoint, token: TOKEN })
    expect((await failure(transport.request('search', { query: 'Harbor' }))).code).toBe('oversized')
  })

  it('refuses an oversized request before connecting', async () => {
    const brain = await fakeBrain(() => undefined)
    const transport = createNodeBrainTransport({ endpoint: brain.endpoint, token: TOKEN })
    const query = 'x'.repeat(BRAIN_MAX_FRAME_BYTES)
    expect((await failure(transport.request('search', { query }))).code).toBe('oversized')
    expect(brain.requests).toEqual([])
  })

  it('times out a silent server', async () => {
    const brain = await fakeBrain(() => undefined)
    const transport = createNodeBrainTransport(
      { endpoint: brain.endpoint, token: TOKEN },
      { timeoutMs: 30 },
    )
    const error = await failure(transport.request('search', { query: 'Harbor' }))
    expect(error.code).toBe('timeout')
    expect(error.message).not.toContain(TOKEN)
  })

  it('maps a caller timeout signal to timeout and a caller abort to aborted', async () => {
    const brain = await fakeBrain(() => undefined)
    const transport = createNodeBrainTransport({ endpoint: brain.endpoint, token: TOKEN })
    expect(
      (await failure(transport.request('search', { query: 'Harbor' }, AbortSignal.timeout(20))))
        .code,
    ).toBe('timeout')
    const controller = new AbortController()
    const pending = transport.request('search', { query: 'Harbor' }, controller.signal)
    setTimeout(() => controller.abort(), 10)
    expect((await failure(pending)).code).toBe('aborted')
  })

  it('does not connect when the signal is already aborted', async () => {
    const brain = await fakeBrain(() => undefined)
    const transport = createNodeBrainTransport({ endpoint: brain.endpoint, token: TOKEN })
    expect(
      (await failure(transport.request('search', { query: 'Harbor' }, AbortSignal.abort()))).code,
    ).toBe('aborted')
    expect(brain.requests).toEqual([])
  })

  it('reports a missing socket as a connection failure without the path or token', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'brain-'))
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
    const endpoint = join(directory, 'absent')
    const error = await failure(
      createNodeBrainTransport({ endpoint, token: TOKEN }).request('search', { query: 'Harbor' }),
    )
    expect(error.code).toBe('connection')
    expect(error.message).not.toContain(directory)
    expect(error.message).not.toContain(TOKEN)
  })

  it.each(['', 'has space', 'line\nbreak', 'x'.repeat(4097)])(
    'refuses malformed token %j at construction',
    (token) => {
      expect(() => createNodeBrainTransport({ endpoint: '/tmp/brain.sock', token })).toThrow(
        expect.objectContaining({ code: 'invalid_connection' }),
      )
    },
  )
})

describe('isBrainEndpoint', () => {
  it.each([
    ['/tmp/phosphor/brain.sock', 'darwin', true],
    ['relative/brain.sock', 'linux', false],
    ['http://127.0.0.1:8080', 'darwin', false],
    ['127.0.0.1:8080', 'linux', false],
    ['tcp://localhost:9', 'linux', false],
    ['\\\\.\\pipe\\phosphor-brain-1', 'win32', true],
    ['\\\\server\\pipe\\phosphor-brain', 'win32', false],
    ['C:\\brain.sock', 'win32', false],
    ['/tmp/brain.sock', 'win32', false],
  ] as const)('%s on %s is %s', (endpoint, platform, expected) => {
    expect(isBrainEndpoint(endpoint, platform)).toBe(expected)
  })

  it('makes the transport refuse a TCP-shaped endpoint', () => {
    expect(() => createNodeBrainTransport({ endpoint: 'localhost:9', token: TOKEN })).toThrow(
      expect.objectContaining({ code: 'invalid_connection' }),
    )
  })
})

describe('brainConnectionFromEnv', () => {
  it('needs both the endpoint and the token', () => {
    expect(brainConnectionFromEnv({})).toBeNull()
    expect(brainConnectionFromEnv({ PHOSPHOR_BRAIN_ENDPOINT: '/s' })).toBeNull()
    expect(brainConnectionFromEnv({ PHOSPHOR_BRAIN_TOKEN: 't' })).toBeNull()
    expect(
      brainConnectionFromEnv({ PHOSPHOR_BRAIN_ENDPOINT: '/s', PHOSPHOR_BRAIN_TOKEN: 't' }),
    ).toEqual({ endpoint: '/s', token: 't' })
  })
})
