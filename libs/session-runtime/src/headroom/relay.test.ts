import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { startHeadroomRelay } from './relay'

let dir: string
let socketPath: string
let close: () => Promise<void>
let live: number | undefined
const seen: string[] = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hr-'))
  socketPath = join(dir, 'h.sock')
  seen.length = 0
  const child = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    expect(req.headers['x-private']).toBeUndefined()
    if (req.method === 'GET') res.end('ok')
    else req.pipe(res)
  })
  await new Promise<void>((resolve) => child.listen(0, '127.0.0.1', resolve))
  live = (child.address() as AddressInfo).port
  const relay = await startHeadroomRelay(socketPath, () => live, 16)
  close = async () => {
    await relay.close()
    await new Promise<void>((resolve) => child.close(() => resolve()))
  }
})
afterEach(async () => {
  await close()
  await rm(dir, { recursive: true, force: true })
})

function send(method: string, path: string, chunks: string[] = [], headers = {}) {
  return new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const req = request(
      { socketPath, path, method, headers: { 'x-private': 'never forwarded', ...headers } },
      (res) => {
        let body = ''
        res.on('data', (chunk) => {
          body += String(chunk)
        })
        res.on('error', reject)
        res.on('end', () => resolve({ status: res.statusCode, body }))
      },
    )
    req.on('error', reject)
    for (const chunk of chunks) req.write(chunk)
    req.end()
  })
}

it('forwards the two exact routes and bodies, not caller headers', async () => {
  expect((await stat(socketPath)).mode & 0o777).toBe(0o600)
  expect(await send('GET', '/health')).toEqual({ status: 200, body: 'ok' })
  expect(await send('POST', '/v1/compress', ['12345678', '12345678'])).toEqual({
    status: 200,
    body: '1234567812345678',
  })
  for (const [method, path] of [
    ['POST', '/health'],
    ['GET', '/v1/compress'],
    ['POST', '/v1/compress?other'],
    ['GET', '/other'],
  ] as const)
    expect((await send(method, path)).status).toBe(404)
  expect(seen).toEqual(['GET /health', 'POST /v1/compress'])
})

it('refuses declared and chunked oversized bodies without sending even a prefix', async () => {
  expect(
    (await send('POST', '/v1/compress', ['a'.repeat(17)], { 'content-length': '17' })).status,
  ).toBe(413)
  expect((await send('POST', '/v1/compress', ['12345678', '12345678', 'x'])).status).toBe(413)
  expect((await send('GET', '/health', ['x'], { 'content-length': '1' })).status).toBe(413)
  expect(seen).toEqual([])
})

it('returns 503 instead of following the port after losing the child', async () => {
  live = undefined
  expect((await send('POST', '/v1/compress', ['private'])).status).toBe(503)
  expect(seen).toEqual([])
})
