import { request } from 'node:http'
import { connect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { listenForCallback, type CallbackListener } from './loopback'

const listeners: CallbackListener[] = []
afterEach(() => {
  for (const listener of listeners.splice(0)) listener.close()
})

async function listen(timeoutMs = 10_000, signal?: AbortSignal, holdMs?: number) {
  const listener = await listenForCallback(timeoutMs, signal, holdMs)
  listeners.push(listener)
  return listener
}

function get(url: string, host?: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(url, { headers: host ? { host } : {}, agent: false }, (res) => {
      let body = ''
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

function raw(port: string, target: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(Number(port), '127.0.0.1', () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`)
    })
    let answer = ''
    socket.on('data', (chunk) => (answer += chunk))
    socket.on('end', () => resolve(answer.split('\r\n')[0] ?? ''))
    socket.on('error', reject)
  })
}

async function expectPending(outcome: Promise<unknown>) {
  const pending = Symbol('pending')
  expect(await Promise.race([outcome, new Promise((r) => setTimeout(() => r(pending), 20))])).toBe(
    pending,
  )
}

describe('loopback request boundary characterization', () => {
  it('rejects malformed and foreign absolute targets without spending the callback', async () => {
    const listener = await listen()
    const { port, pathname } = new URL(listener.url)
    expect(await raw(port, '//')).toMatch(/^HTTP\/1\.1 400 /)
    expect(await raw(port, `/\\evil.example${pathname}?code=abcd-1234`)).toMatch(/ 404 /)
    expect(await raw(port, `http://evil.example${pathname}?code=abcd-1234`)).toMatch(/ 404 /)
    await expectPending(listener.outcome)
    const tab = get(`${listener.url}?code=abcd-1234`)
    expect(await listener.outcome).toEqual({ kind: 'code', code: 'abcd-1234' })
    listener.close()
    expect((await tab).status).toBe(200)
  })

  it('requires the exact numeric Host and leaves the flow pending after 421', async () => {
    const listener = await listen()
    const { port } = new URL(listener.url)
    for (const host of [`localhost:${port}`, `evil.example:${port}`, '127.0.0.1']) {
      expect((await get(`${listener.url}?error=access_denied`, host)).status).toBe(421)
    }
    await expectPending(listener.outcome)
  })

  it('returns 410 to a second callback while keeping the first response held', async () => {
    const listener = await listen()
    const first = get(`${listener.url}?code=abcd-1234`)
    expect(await listener.outcome).toEqual({ kind: 'code', code: 'abcd-1234' })
    await expectPending(first)
    expect((await get(`${listener.url}?error=access_denied`)).status).toBe(410)
    expect(await listener.outcome).toEqual({ kind: 'code', code: 'abcd-1234' })
    listener.finish({ title: 'Complete', message: 'The first tab wins.' })
    expect(await first).toMatchObject({ status: 200, body: expect.stringContaining('Complete') })
  })
})

describe('loopback lifecycle characterization', () => {
  it('answers a held tab on abort without replacing its code outcome or later answering twice', async () => {
    const abort = new AbortController()
    const listener = await listen(10_000, abort.signal)
    const tab = get(`${listener.url}?code=abcd-1234`)
    expect(await listener.outcome).toEqual({ kind: 'code', code: 'abcd-1234' })
    abort.abort()
    expect(await tab).toMatchObject({
      status: 200,
      body: expect.stringContaining('Sign-in cancelled'),
    })
    expect(await listener.outcome).toEqual({ kind: 'code', code: 'abcd-1234' })
    listener.finish({ title: 'Too late', message: 'Ignored' })
    await expect(get(listener.url)).rejects.toThrow(/ECONNREFUSED/)
  })

  it('closes at the deadline and allocates a fresh nonce for the next listener', async () => {
    const listener = await listen(30)
    expect(await listener.outcome).toEqual({ kind: 'timeout' })
    await expect(get(listener.url)).rejects.toThrow(/ECONNREFUSED/)
    const next = await listen()
    expect(new URL(next.url).pathname).not.toBe(new URL(listener.url).pathname)
    const stale = new URL(next.url)
    stale.pathname = new URL(listener.url).pathname
    expect((await get(`${stale}?code=abcd-1234`)).status).toBe(404)
    await expectPending(next.outcome)
  })

  it('keeps a received code beyond the deadline and releases a forgotten tab at its hold limit', async () => {
    const listener = await listen(100, undefined, 150)
    const tab = get(`${listener.url}?code=abcd-1234`)
    expect(await listener.outcome).toEqual({ kind: 'code', code: 'abcd-1234' })
    expect(await tab).toMatchObject({
      status: 200,
      body: expect.stringContaining('Return to Phosphor'),
    })
    expect(await listener.outcome).toEqual({ kind: 'code', code: 'abcd-1234' })
    await expect(get(listener.url)).rejects.toThrow(/ECONNREFUSED/)
  })
})
