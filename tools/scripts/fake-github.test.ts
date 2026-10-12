import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { expect, it } from 'vitest'

type Request = {
  url: string
  method: string
  headers: Record<string, string>
  [Symbol.asyncIterator](): AsyncIterator<Buffer>
}
type Response = {
  writeHead(status: number, headers: Record<string, string>): void
  end(body: string): void
}
function fixture() {
  let handler: ((req: Request, res: Response) => Promise<void>) | undefined
  const context = createContext({
    Buffer,
    URL,
    URLSearchParams,
    process: { on: () => {} },
    require: (name: string) => {
      if (name === 'node:crypto') return { randomUUID }
      if (name === 'node:http')
        return {
          createServer: (fn: typeof handler) => {
            handler = fn
            return { listen: () => {} }
          },
        }
      throw new Error('Unexpected fixture dependency')
    },
  })
  runInContext(
    readFileSync(new URL('../../supabase/tests/fixtures/fake-github.cjs', import.meta.url), 'utf8'),
    context,
  )
  const token = randomBytes(16).toString('hex')
  runInContext(`tokens.add(${JSON.stringify(token)})`, context)
  return async (url: string, body = '', method = 'POST') => {
    if (!handler) throw new Error('Fixture did not create a handler')
    let status = 0
    let result = ''
    await handler(
      {
        url,
        method,
        headers: { authorization: 'Bearer ' + token },
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(body)
        },
      },
      {
        writeHead: (value) => {
          status = value
        },
        end: (value) => {
          result = value
        },
      },
    )
    return { status, result }
  }
}
it('defaults to A, accepts exactly two profiles and never stores malformed selectors', async () => {
  const call = fixture()
  expect((await call('/api/v3/user', '', 'GET')).result).toContain('"login":"phosphor-e2e"')
  expect((await call('/__user', 'b')).status).toBe(200)
  expect((await call('/api/v3/user', '', 'GET')).result).toContain('"login":"phosphor-e2e-b"')
  for (const body of ['c', '{}', 'B', ' b ', 'x'.repeat(1024)])
    expect((await call('/__user', body)).status).toBe(400)
  expect((await call('/__user', 'x'.repeat(1025))).status).toBe(413)
  expect((await call('/api/v3/user', '', 'GET')).result).toContain('"login":"phosphor-e2e-b"')
  expect((await call('/__user', 'a')).status).toBe(200)
  expect((await call('/api/v3/user/emails', '', 'GET')).result).toContain('e2e@example.test')
})
