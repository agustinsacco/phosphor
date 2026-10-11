import { request } from 'node:http'
import { networkInterfaces } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { listenForCallback, type CallbackListener } from './loopback'

const open: CallbackListener[] = []
afterEach(() => {
  for (const listener of open.splice(0)) listener.close()
})

async function listen(timeoutMs = 10_000, signal?: AbortSignal, holdMs?: number) {
  const listener = await listenForCallback(timeoutMs, signal, holdMs)
  open.push(listener)
  return listener
}

/** A raw GET, so the Host header can lie the way a DNS-rebound page's does. */
function get(url: string, host?: string, method = 'GET') {
  const target = new URL(url)
  return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>(
    (resolve, reject) => {
      const req = request(
        target,
        { method, headers: host ? { host } : {}, agent: false },
        (res) => {
          let body = ''
          res.on('data', (chunk) => (body += chunk))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
        },
      )
      req.on('error', reject)
      req.end()
    },
  )
}

const pending = Symbol('pending')
const settledYet = (outcome: Promise<unknown>) =>
  Promise.race([outcome, new Promise((r) => setTimeout(() => r(pending), 20))])

describe('listenForCallback', () => {
  it('listens on 127.0.0.1 alone, at a port the OS picked', async () => {
    const listener = await listen()
    expect(listener.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)
    expect(listener.url).not.toMatch(/:0\//)
  })

  // Any address but loopback must refuse the connection outright: an answer,
  // even the 421 below, would mean the port is reachable from the network.
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((nic) => nic && nic.family === 'IPv4' && !nic.internal)?.address
  it.skipIf(!lan)('cannot be reached on a network address', async () => {
    const listener = await listen()
    const { port, pathname } = new URL(listener.url)
    await expect(get(`http://${lan}:${port}${pathname}`)).rejects.toThrow(/ECONNREFUSED/)
  })

  it("hands over the code and answers the tab with the flow's own page", async () => {
    const listener = await listen()
    const tab = get(`${listener.url}?code=abcd-1234-efgh`)
    expect(await listener.outcome).toEqual({ kind: 'code', code: 'abcd-1234-efgh' })
    listener.finish({ title: 'Signed <in>', message: 'as @octo & co' })
    const page = await tab
    expect(page.status).toBe(200)
    expect(page.body).toContain('Signed &#60;in&#62;')
    expect(page.body).toContain('as @octo &#38; co')
    expect(page.headers).toMatchObject({
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      connection: 'close',
    })
    await expect(get(listener.url)).rejects.toThrow(/ECONNREFUSED/)
  })

  it('reports a denial with its description', async () => {
    const listener = await listen()
    void get(`${listener.url}?error=access_denied&error_description=The+user+said+no`)
    expect(await listener.outcome).toEqual({
      kind: 'denied',
      error: 'access_denied',
      description: 'The user said no',
    })
  })

  it('spends its one use only on a real callback', async () => {
    const listener = await listen()
    const port = new URL(listener.url).port
    expect((await get(`http://127.0.0.1:${port}/favicon.ico`)).status).toBe(404)
    expect((await get(`${listener.url}?code=abcd-1234`, undefined, 'POST')).status).toBe(404)
    expect((await get(`${listener.url}?code=short`)).status).toBe(400)
    expect((await get(listener.url)).status).toBe(400)
    const rebound = await get(`${listener.url}?code=abcd-1234`, `evil.example:${port}`)
    expect(rebound.status).toBe(421)
    expect(await settledYet(listener.outcome)).toBe(pending)
    void get(`${listener.url}?code=abcd-1234`)
    expect(await listener.outcome).toEqual({ kind: 'code', code: 'abcd-1234' })
  })

  it('tells a second tab the link was used while the first is still held', async () => {
    const listener = await listen()
    const first = get(`${listener.url}?code=abcd-1234`)
    await listener.outcome
    expect((await get(`${listener.url}?code=abcd-5678`)).status).toBe(410)
    listener.finish({ title: 'Done', message: 'ok' })
    expect((await first).status).toBe(200)
  })

  it('gives up at its deadline and stops listening', async () => {
    const listener = await listen(30)
    expect(await listener.outcome).toEqual({ kind: 'timeout' })
    await expect(get(listener.url)).rejects.toThrow(/ECONNREFUSED/)
  })

  it('stops on abort, even one that came before it listened', async () => {
    const abort = new AbortController()
    const listener = await listen(10_000, abort.signal)
    abort.abort()
    expect(await listener.outcome).toEqual({ kind: 'cancelled' })
    await expect(get(listener.url)).rejects.toThrow(/ECONNREFUSED/)
    const early = await listen(10_000, AbortSignal.abort())
    expect(await early.outcome).toEqual({ kind: 'cancelled' })
  })

  it('answers a tab the flow forgot with a generic page', async () => {
    const listener = await listen(10_000, undefined, 30)
    const tab = get(`${listener.url}?code=abcd-1234`)
    await listener.outcome
    const page = await tab
    expect(page.status).toBe(200)
    expect(page.body).toContain('Return to Phosphor')
  })
})
