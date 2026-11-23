import { mkdtempSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { HARBOR_RECALL } from '@phosphor/brain-client/__fixtures__/recall'
import type { OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import type { ReadyConnection } from '../api/connection'
import { createOwnerAdapter } from '../owner/adapter'
import { createBrainHandlers } from '../ops/handlers/brain'
import { createAppServices } from './app-services'

const token = 'private-test-capability'
const uid = process.getuid!()
const dirs: string[] = []
const dir = () => {
  const path = mkdtempSync(join(tmpdir(), 'br-'))
  dirs.push(path)
  return path
}
afterEach(() => dirs.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })))

const context: OpHandlerContext = {
  principal: { kind: 'agent', laneRef: 'ref', sessionId: 'session', unattended: false, lineage: 0 },
  signal: new AbortController().signal,
  lane: {
    ref: 'ref',
    sessionId: 'session',
    title: 'Owner',
    cwd: '/repo',
    busy: false,
    controller: null,
  },
  log: vi.fn(),
}
function harness() {
  const state = dir()
  const services = createAppServices(state, uid)
  const handlers = createBrainHandlers(services)
  const sent: string[] = []
  function connection(connectionId: string) {
    return createOwnerAdapter(services.handlers)({
      connectionId,
      principal: { kind: 'owner', clientId: 'desktop' },
      client: { id: 'desktop', label: 'Desktop' },
      socket: { isOpen: () => true, send: (text: string) => sent.push(text) },
    } as ReadyConnection)!
  }
  async function register(link: ReturnType<typeof connection>, endpoint: string, recall = true) {
    const index = sent.length
    link.handle(
      {
        type: 'call',
        id: 'r',
        method: 'app.service.register',
        params: { service: 'brain', endpoint, token, recall },
      },
      [],
    )
    await vi.waitFor(() =>
      expect(JSON.parse(sent[index]!)).toEqual({
        type: 'result',
        id: 'r',
        ok: true,
        data: { registered: true },
      }),
    )
  }
  return { state, services, handlers, connection, register, sent }
}
it('keeps only recall preferences after the registering connection closes, including across restart', async () => {
  const h = harness()
  const endpoint = join(dir(), 'rpc.sock')
  expect(h.services.status()).toEqual({ brain: 'none' })
  const first = h.connection('first'),
    second = h.connection('second')
  await h.register(first, endpoint)
  await h.register(second, endpoint)
  first.close?.()
  expect(h.services.status()).toEqual({ brain: 'registered' })
  second.close?.()
  expect(h.services.status()).toEqual({ brain: 'known' })
  const restarted = createAppServices(h.state, uid)
  expect(restarted.resources('/res')).toEqual({
    extensions: ['/res/brain-ext/brain.mjs'],
    skills: ['/res/skills/brain'],
  })
  const record = readFileSync(join(h.state, 'app-services.json'), 'utf8')
  expect(record).not.toContain(endpoint)
  expect(record + h.sent.join('')).not.toContain(token)
  expect(await h.handlers['brain.search']({ query: 'Harbor' }, context)).toMatchObject({
    data: { status: 'unavailable' },
  })
})
it('uses the owner lane and its last briefing, and checks the private socket on each call', async () => {
  const h = harness(),
    folder = dir(),
    endpoint = join(folder, 'rpc.sock')
  const requests: { method: string; params: unknown; token: string }[] = []
  const server = createServer((socket) => {
    socket.once('data', (chunk: Buffer) => {
      const frame = JSON.parse(chunk.toString()) as (typeof requests)[number]
      requests.push(frame)
      socket.end(
        JSON.stringify({
          ok: true,
          data: frame.method === 'search' ? HARBOR_RECALL : { status: 'filed', message: 'Filed.' },
        }) + '\n',
      )
    })
  })
  await new Promise<void>((ok, fail) => server.once('error', fail).listen(endpoint, ok))
  const owner = h.connection('one')
  try {
    await h.register(owner, endpoint)
    const closeLane = h.services.attachLane('session', '/repo')
    const search = () =>
      h.handlers['brain.search']({ query: 'Harbor', cwd: '/wrong', sessionId: 'wrong' }, context)
    expect(await search()).toMatchObject({ data: { status: 'ok', memories: 1 } })
    expect(requests[0]).toMatchObject({
      method: 'search',
      token,
      params: { cwd: '/repo', sessionId: 'session' },
    })
    expect(
      await h.handlers['brain.flag']({ ref: 1, problem: 'wrong', reason: 'Verified.' }, context),
    ).toMatchObject({ data: { status: 'filed' } })
    expect(requests[1]?.params).toMatchObject({
      title: 'Owner',
      sessionId: 'session',
      memoryId: HARBOR_RECALL.hits[0]!.memory.id,
    })
    chmodSync(folder, 0o755)
    expect(await search()).toMatchObject({ data: { status: 'unavailable' } })
    expect(requests).toHaveLength(2)
    chmodSync(folder, 0o700)
    closeLane()
    expect(await search()).toMatchObject({ data: { status: 'unavailable' } })
    await h.register(owner, endpoint, false)
    expect(h.services.resources('/res')).toBeUndefined()
    expect(context.log).not.toHaveBeenCalled()
  } finally {
    owner.close?.()
    await new Promise<void>((ok) => server.close(() => ok()))
  }
})
