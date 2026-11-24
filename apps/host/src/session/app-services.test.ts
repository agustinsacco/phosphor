import { mkdtempSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import type { LiveSession } from '@phosphor/session-runtime/pi/session-registry'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { HARBOR_RECALL } from '@phosphor/brain-client/__fixtures__/recall'
import type { OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import { createBrainContribution } from './contributions/brain'
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
      caps: [],
      principal: { kind: 'owner', clientId: 'desktop' },
      client: { id: 'desktop', label: 'Desktop' },
      socket: {
        isOpen: () => true,
        send: (text: string) => sent.push(text),
        close: vi.fn(),
        onMessage: vi.fn(),
        onClose: vi.fn(),
        bufferedBytes: () => 0,
      },
    })!
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
  h.services.attachLane('session', '/repo')
  second.close?.()
  expect(h.services.status()).toEqual({ brain: 'known' })
  const restarted = createAppServices(h.state, uid)
  const contribution = createBrainContribution({ appServices: restarted, resourceRoot: '/res' })
  expect(await contribution.spawn({}, { options: { workspacePath: '/repo' } })).toEqual({
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
async function brainSocket(endpoint: string) {
  const requests: {
    method: string
    params: { memoryId?: string; sessionId: string }
    token: string
  }[] = []
  const kept = new Set<string>()
  const server = createServer((socket) => {
    socket.once('data', (chunk: Buffer) => {
      const frame = JSON.parse(chunk.toString()) as (typeof requests)[number]
      requests.push(frame)
      const key = JSON.stringify([frame.params.sessionId, frame.params.memoryId])
      const status = kept.has(key) ? 'already_flagged' : 'filed'
      if (frame.method === 'flag') kept.add(key)
      socket.end(
        JSON.stringify({
          ok: true,
          data: frame.method === 'search' ? HARBOR_RECALL : { status, message: status },
        }) + '\n',
      )
    })
  })
  await new Promise<void>((ok, fail) => server.once('error', fail).listen(endpoint, ok))
  return { requests, server }
}
it('uses the owner lane and its last briefing, and checks the private socket on each call', async () => {
  const h = harness(),
    folder = dir(),
    endpoint = join(folder, 'rpc.sock')
  const { requests, server } = await brainSocket(endpoint)
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
      params: { cwd: '/repo', sessionId: 'harbor-pi' },
    })
    expect(
      await h.handlers['brain.flag']({ ref: 1, problem: 'wrong', reason: 'Verified.' }, context),
    ).toMatchObject({ data: { status: 'filed' } })
    expect(requests[1]?.params).toMatchObject({
      title: 'Owner',
      sessionId: 'harbor-pi',
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

it('refuses a repeat flag after a restart of the same pi lane', async ({ onTestFinished }) => {
  const h = harness(),
    endpoint = join(dir(), 'rpc.sock')
  const { server } = await brainSocket(endpoint)
  onTestFinished(() => new Promise<void>((ok) => server.close(() => ok())))
  const owner = h.connection('one')
  onTestFinished(() => owner.close?.())
  await h.register(owner, endpoint)
  const contribution = createBrainContribution({ appServices: h.services, resourceRoot: '/res' })
  async function flagAndStop(handle: string) {
    const client = Object.assign(new EventEmitter(), {
      piSessionId: undefined as string | undefined,
    })
    const live = { sessionId: handle, client, workspacePath: '/repo' } as unknown as LiveSession
    contribution.attach!(live, { execution: {}, options: { workspacePath: '/repo' }, log: vi.fn() })
    client.piSessionId = 'harbor-pi'
    const ctx: OpHandlerContext = {
      ...context,
      lane: { ...context.lane!, sessionId: handle },
      principal: {
        kind: 'agent',
        laneRef: 'ref',
        sessionId: handle,
        unattended: false,
        lineage: 0,
      },
    }
    expect(await h.handlers['brain.search']({ query: 'Harbor' }, ctx)).toMatchObject({
      data: { memories: 1 },
    })
    const reply = await h.handlers['brain.flag'](
      { ref: 1, problem: 'wrong', reason: 'Harbor changed.' },
      ctx,
    )
    client.emit('exit')
    return reply
  }
  expect(await flagAndStop('first')).toMatchObject({ data: { status: 'filed' } })
  expect(await flagAndStop('second')).toMatchObject({ data: { status: 'already_flagged' } })
})
