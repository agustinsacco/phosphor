import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createLoopbackPair } from '@shared/host-protocol-testing'
import {
  helloProofMessage,
  parseClientFrame,
  type ClientFrame,
  type HostFrame,
  type LaneSummary,
} from '@shared/host-protocol'
import type { TerminalFrame } from '@shared/host-protocol-terminals'
import { createHostConnection } from './connection'
import { createRemoteTerminals } from './terminals'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})
const drain = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}
async function setup() {
  const hostId = randomUUID(),
    clientId = randomUUID(),
    terminalId = randomUUID()
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ format: 'jwk' }).x
  if (!publicKey) throw new Error('Missing test key')
  let lane: LaneSummary = {
    laneId: randomUUID(),
    repositoryId: '0123456789abcdef',
    cwd: '/fictional',
    title: null,
    branch: null,
    worktree: false,
    model: null,
    activity: 'idle',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    attention: 0,
    read: 0,
    control: { fence: 7, controller: { clientId, label: 'Test', connected: true } },
  }
  let caps: ('terminal' | 'sessions.read' | 'sessions.control')[] = [
    'terminal',
    'sessions.read',
    'sessions.control',
  ]
  let epoch = '1111111111111111',
    inputSeq = 0,
    outputSeq = 0,
    status: 'running' | 'interrupted' = 'running'
  let ack = true,
    autoReceipt = true,
    current = true,
    autoReset = true,
    empty = false
  let pair = createLoopbackPair()
  const frames: ClientFrame[] = []
  let subscription = ''
  const send = (frame: HostFrame) => pair.server.send(JSON.stringify(frame))
  const reset = (data = 'prompt') =>
    send({
      type: 'terminal.reset',
      id: subscription,
      terminalId,
      epoch,
      seq: outputSeq,
      data,
      inputSeq,
      status,
    })
  const log = vi.fn()
  const inputDropped = vi.fn()
  const connection = createHostConnection({
    log,
    hostId,
    endpoint: 'https://bee.tail.ts.net:47615',
    grant: async () => ({
      grant: 'test-grant',
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      host: { id: hostId, publicKey, endpoint: 'https://bee.tail.ts.net:47615' },
    }),
    socket: async () => {
      pair = createLoopbackPair()
      pair.server.onMessage((text) => {
        const parsed = parseClientFrame(text)
        if (!parsed.ok) throw new Error('Bad client frame')
        const f = parsed.frame
        frames.push(f)
        if (f.type === 'auth')
          send({
            type: 'ready',
            protocolVersion: 1,
            hello: {
              hostId,
              hostVersion: '1.0.0',
              protocolVersion: 1,
              runtimeEpoch: epoch,
              capabilities: caps,
            },
            proof: sign(
              null,
              Buffer.from(helloProofMessage(hostId, epoch, f.challenge ?? '')),
              keys.privateKey,
            ).toString('base64url'),
            connectionId: '2222222222222222',
            grantExpiresAt: new Date(Date.now() + 300000).toISOString(),
            client: { id: clientId, label: 'Test' },
            capabilities: caps,
          })
        else if (f.type === 'subscribe' && f.topic === 'lanes')
          send({
            type: 'lanes',
            id: f.id,
            cursor: { epoch, seq: 0 },
            repositories: [],
            lanes: [lane],
          })
        else if (f.type === 'subscribe' && f.topic === 'terminal') {
          subscription = f.id
          if (autoReset) reset()
        } else if (f.type === 'command' && autoReceipt)
          send({
            type: 'receipt',
            receipt: {
              requestId: f.requestId,
              status: 'done',
              laneId: lane.laneId,
              data: f.op.type === 'terminal.create' ? { terminalId } : undefined,
            },
          })
        else if (f.type === 'call')
          send({
            type: 'result',
            id: f.id,
            ok: true,
            data: empty ? [] : [{ terminalId, laneId: lane.laneId, status }],
          })
        else if (f.type === 'terminal.input' && ack) {
          inputSeq = f.seq
          send({ type: 'terminal.ack', terminalId, seq: f.seq, accepted: true })
        }
      })
      return pair.client
    },
    clearGrant: () => {},
    changed: () => {},
    random: () => 1,
  })
  await drain()
  const emit = vi.fn()
  const bridge = createRemoteTerminals({
    inputDropped,
    clientId: () => clientId,
    emit,
    lane: () => ({ hostId, laneId: lane.laneId, connection, current: () => current }),
  })
  const route = (channel: Parameters<typeof bridge.route>[1], ...args: unknown[]) => {
    const routed = bridge.route(1, channel, args)
    if (!routed) throw new Error('Not routed')
    return routed.result
  }
  async function create() {
    const pending = route('pty:create', `host:${hostId}/repo`, 80, 24, 'session')
    await drain()
    const result = await pending
    if (
      !result ||
      typeof result !== 'object' ||
      !('ptyId' in result) ||
      typeof result.ptyId !== 'string'
    )
      throw new Error('No id')
    return result.ptyId
  }
  async function attach(id: string) {
    const pending = route('pty:attach', id)
    await drain()
    return pending
  }
  function refresh() {
    send({ type: 'lanes', id: 'lanes', cursor: { epoch, seq: 0 }, repositories: [], lanes: [lane] })
  }
  return {
    log,
    inputDropped,
    connection,
    bridge,
    frames,
    emit,
    route,
    create,
    attach,
    reset,
    terminalId,
    lane,
    pauseReset: () => {
      autoReset = false
    },
    setCurrent: () => {
      current = false
    },
    controller: () => {
      lane = {
        ...lane,
        control: { ...lane.control, controller: { clientId, label: 'Test', connected: true } },
      }
      refresh()
    },
    viewer: () => {
      lane = { ...lane, control: { ...lane.control, controller: null } }
      refresh()
    },
    empty: () => {
      empty = true
    },
    loseCapability: (cap: 'terminal' | 'sessions.control' = 'terminal') => {
      caps = caps.filter((c) => c !== cap)
    },
    delayReceipt: () => {
      autoReceipt = false
    },
    noAck: () => {
      ack = false
    },
    receipt: () => {
      const f = [...frames].reverse().find((f) => f.type === 'command')
      if (f?.type === 'command')
        send({
          type: 'receipt',
          receipt: { requestId: f.requestId, status: 'done', data: { terminalId } },
        })
    },
    output: (seq: number, data: string) => {
      outputSeq = seq
      send({ type: 'terminal.output', id: subscription, terminalId, epoch, seq, data })
    },
    interrupt: () => {
      status = 'interrupted'
      reset()
    },
    reconnect: async (restart = false) => {
      if (restart) epoch = '3333333333333333'
      pair.server.close(1000, 'test')
      await vi.advanceTimersByTimeAsync(1000)
      await drain()
    },
    raw: (f: TerminalFrame) => send(f),
  }
}

it('creates with fence and opaque identity, attaches reset scrollback and splits UTF-8 input with acknowledged seq', async () => {
  const t = await setup(),
    id = await t.create()
  expect(id).not.toContain(t.terminalId)
  expect(t.frames.find((f) => f.type === 'command')).toMatchObject({
    fence: 7,
    op: { type: 'terminal.create' },
  })
  expect(await t.attach(id)).toEqual({ scrollback: 'prompt' })
  const writing = t.route('pty:write', id, '😀'.repeat(1025))
  await drain()
  await writing
  expect(t.frames.filter((f) => f.type === 'terminal.input')).toMatchObject([
    { seq: 1, data: '😀'.repeat(1024) },
    { seq: 2, data: '😀' },
  ])
  t.connection.close()
})
it('gap redraw resets exactly once and drops duplicate output', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  t.output(1, 'one')
  await drain()
  t.output(1, 'duplicate')
  await drain()
  t.output(3, 'gap')
  await drain()
  t.output(4, 'four')
  await drain()
  expect(t.emit.mock.calls.map((c) => c[2])).toEqual(['one', '\x1bcprompt', 'four'])
  t.connection.close()
})
it('uncertain input is never resent and reconnect resumes reset inputSeq', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  const first = t.route('pty:write', id, 'first')
  await drain()
  await first
  t.noAck()
  const uncertain = t.route('pty:write', id, 'uncertain')
  await drain()
  await t.reconnect()
  await uncertain
  await t.attach(id)
  const next = t.route('pty:write', id, 'next')
  await drain()
  await vi.advanceTimersByTimeAsync(5000)
  await next
  expect(t.frames.filter((f) => f.type === 'terminal.input')).toMatchObject([
    { seq: 1, data: 'first' },
    { seq: 2, data: 'uncertain' },
    { seq: 2, data: 'next' },
  ])
  expect(
    t.frames.filter((f) => f.type === 'terminal.input' && f.data === 'uncertain'),
  ).toHaveLength(1)
  t.connection.close()
})
it.each(['pty:write', 'pty:resize', 'pty:kill'] as const)(
  'viewer refuses %s in main without sending',
  async (channel) => {
    const t = await setup()
    t.viewer()
    await drain()
    const id = await t.create()
    await t.attach(id)
    const before = t.frames.length
    await expect(t.route(channel, id, channel === 'pty:write' ? 'secret' : 80, 24)).rejects.toThrow(
      'Read-only',
    )
    expect(t.frames.slice(before)).toEqual([])
    expect(t.frames.some((f) => f.type === 'command')).toBe(false)
    t.connection.close()
  },
)
it('capability loss rejects create and existing ops after reconnect', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  t.loseCapability()
  await t.reconnect()
  await expect(t.route('pty:write', id, 'input')).rejects.toThrow('Not available')
  await expect(t.create()).rejects.toThrow('Not available')
  t.connection.close()
})
it('stale handle after create await never delivers an id', async () => {
  const t = await setup()
  t.delayReceipt()
  const creating = t.create()
  const rejected = expect(creating).rejects.toThrow('Not available')
  await drain()
  t.setCurrent()
  t.receipt()
  await drain()
  await rejected
  t.connection.close()
})
it('disposed or replaced handle invalidates mapping and Host restart ends it', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  t.setCurrent()
  t.bridge.reconcile()
  expect(t.emit).toHaveBeenCalledWith(1, `pty:exit:${id}`, 0)
  await expect(t.route('pty:write', id, 'input')).rejects.toThrow('Not available')
  t.connection.close()
  const r = await setup(),
    rid = await r.create()
  await r.attach(rid)
  await r.reconnect(true)
  r.bridge.reconcile()
  expect(r.emit).toHaveBeenCalledWith(1, `pty:exit:${rid}`, 0)
  await expect(r.route('pty:write', rid, 'input')).rejects.toThrow('Not available')
  r.connection.close()
})
it('interrupted reset shows ended and refuses input', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  t.interrupt()
  await drain()
  await vi.advanceTimersByTimeAsync(0)
  expect(t.emit).toHaveBeenCalledWith(1, `pty:exit:${id}`, 0)
  await expect(t.route('pty:write', id, 'input')).rejects.toThrow('Read-only')
  t.connection.close()
})

it('reconnect suspends all mutations until reset and discards the rest of an uncertain split write', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  t.noAck()
  t.pauseReset()
  const writing = t.route('pty:write', id, 'x'.repeat(5000))
  await drain()
  await t.reconnect()
  await writing
  for (const channel of ['pty:write', 'pty:resize', 'pty:kill'] as const)
    await expect(t.route(channel, id, channel === 'pty:write' ? 'input' : 80, 24)).rejects.toThrow(
      'Read-only',
    )
  expect(t.frames.filter((f) => f.type === 'terminal.input')).toHaveLength(1)
  t.reset()
  await drain()
  const resize = t.route('pty:resize', id, 90, 25)
  await drain()
  await resize
  expect(t.frames.filter((f) => f.type === 'command').at(-1)).toMatchObject({
    op: { type: 'terminal.resize' },
  })
  t.connection.close()
})
it('stale handle after input ack drops unsent chunks and later stream output', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  const writing = t.route('pty:write', id, 'x'.repeat(5000))
  t.setCurrent()
  await drain()
  await writing
  expect(t.frames.filter((f) => f.type === 'terminal.input')).toHaveLength(1)
  t.output(1, 'private')
  await drain()
  expect(t.emit).not.toHaveBeenCalled()
  t.connection.close()
})

it('viewer lists existing terminals once per identity and receives the fixed empty message', async () => {
  const t = await setup()
  t.viewer()
  await drain()
  const id = await t.create()
  expect(await t.create()).toBe(id)
  expect(t.frames.filter((f) => f.type === 'call')).toMatchObject([
    { method: 'terminal.list', params: { laneId: t.lane.laneId } },
    { method: 'terminal.list', params: { laneId: t.lane.laneId } },
  ])
  expect(t.frames.some((f) => f.type === 'command')).toBe(false)
  t.empty()
  await expect(t.create()).rejects.toThrow('Read-only: no terminals available.')
  t.connection.close()
})
it.each(['terminal', 'sessions.control'] as const)(
  'loss of %s refuses write, resize and kill even after a fresh reset',
  async (cap) => {
    const t = await setup(),
      id = await t.create()
    await t.attach(id)
    t.loseCapability(cap)
    await t.reconnect()
    t.reset()
    await drain()
    const before = t.frames.length
    for (const channel of ['pty:write', 'pty:resize', 'pty:kill'] as const)
      await expect(
        t.route(channel, id, channel === 'pty:write' ? 'private' : 80, 24),
      ).rejects.toThrow()
    expect(t.frames.slice(before)).toEqual([])
    t.connection.close()
  },
)
it('lost controller on reconnect remains read-only after reset', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  t.viewer()
  await t.reconnect()
  for (const channel of ['pty:write', 'pty:resize', 'pty:kill'] as const)
    await expect(
      t.route(channel, id, channel === 'pty:write' ? 'private' : 80, 24),
    ).rejects.toThrow('Read-only')
  t.connection.close()
})
it('fresh reset during an input await is not overwritten by its acknowledgement', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  const writing = t.route('pty:write', id, 'x'.repeat(5000))
  t.reset()
  await drain()
  await writing
  const next = t.route('pty:write', id, 'next')
  await drain()
  await next
  expect(t.frames.filter((f) => f.type === 'terminal.input')).toMatchObject([
    { seq: 1, data: 'x'.repeat(4096) },
    { seq: 2, data: 'next' },
  ])
  t.connection.close()
})
it('rejects malformed dimensions and oversized input without sending', async () => {
  const t = await setup()
  await expect(t.route('pty:create', 'host:test/repo', 1001, 24, 'session')).rejects.toThrow(
    'Invalid',
  )
  const id = await t.create()
  await t.attach(id)
  const before = t.frames.length
  await expect(t.route('pty:resize', id, 80, 0)).rejects.toThrow('Invalid')
  await expect(t.route('pty:write', id, 'x'.repeat(65537))).rejects.toThrow('refused')
  expect(t.frames.slice(before)).toEqual([])
  t.connection.close()
})

it('stream gap suspends mutations until its replacement reset', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  t.pauseReset()
  t.output(2, 'gap')
  await drain()
  await expect(t.route('pty:resize', id, 80, 24)).rejects.toThrow('Read-only')
  t.connection.close()
})
it('new socket without pending input requires a reset before any mutation', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  t.pauseReset()
  await t.reconnect()
  await expect(t.route('pty:resize', id, 80, 24)).rejects.toThrow('Read-only')
  t.connection.close()
})
it('unacked timeout drops remaining input and logs only a fixed event', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  t.noAck()
  const writing = t.route('pty:write', id, 'private'.repeat(800))
  await drain()
  await vi.advanceTimersByTimeAsync(5000)
  await writing
  expect(t.frames.filter((f) => f.type === 'terminal.input')).toHaveLength(1)
  expect(t.inputDropped.mock.calls).toEqual([[]])
  t.receipt() // A duplicate receipt has no pending operation to classify.
  await drain()
  expect(t.log.mock.calls.some((c) => c[1] === 'receipt')).toBe(false)
  expect(JSON.stringify(t.log.mock.calls)).not.toContain(t.terminalId)
  expect(JSON.stringify(t.log.mock.calls)).not.toContain('private')
  t.connection.close()
})

it('another window cannot attach or mutate an opaque terminal', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  for (const channel of ['pty:attach', 'pty:write', 'pty:resize', 'pty:kill'] as const) {
    const routed = t.bridge.route(2, channel, [id, 'private', 24])
    if (!routed) throw new Error('Not routed')
    await expect(routed.result).rejects.toThrow('Not available')
  }
  t.connection.close()
})
it('control lost during create await never returns a terminal identity', async () => {
  const t = await setup()
  t.delayReceipt()
  const creating = t.create()
  const rejected = expect(creating).rejects.toThrow('Not available')
  await drain()
  t.viewer()
  t.receipt()
  await drain()
  await rejected
  t.connection.close()
})
it('malformed Host terminal results fail closed with fixed messages', async () => {
  const t = await setup()
  vi.spyOn(t.connection, 'send').mockResolvedValue({
    requestId: randomUUID(),
    status: 'done',
    data: { terminalId: '/private' },
  })
  await expect(t.create()).rejects.toThrow('Terminal creation not confirmed.')
  t.viewer()
  await drain()
  vi.spyOn(t.connection, 'call').mockResolvedValue({
    type: 'result',
    id: randomUUID(),
    ok: true,
    data: [{ terminalId: t.terminalId, laneId: '/private', status: 'running' }],
  })
  await expect(t.create()).rejects.toThrow('Read-only: no terminals available.')
  t.connection.close()
})

it('queues ordinary keystrokes in order until the delayed acknowledgement', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  t.noAck()
  const first = t.route('pty:write', id, 'a')
  const second = t.route('pty:write', id, 'b')
  await drain()
  expect(t.frames.filter((f) => f.type === 'terminal.input')).toMatchObject([{ seq: 1, data: 'a' }])
  t.raw({ type: 'terminal.ack', terminalId: t.terminalId, seq: 1, accepted: true })
  await drain()
  expect(t.frames.filter((f) => f.type === 'terminal.input')).toMatchObject([
    { seq: 1, data: 'a' },
    { seq: 2, data: 'b' },
  ])
  t.raw({ type: 'terminal.ack', terminalId: t.terminalId, seq: 2, accepted: true })
  await drain()
  await Promise.all([first, second])
  t.connection.close()
})
it.each(['timeout', 'reset', 'control', 'rejection', 'disposal', 'generation'] as const)(
  'drops queued input after %s without sending it',
  async (reason) => {
    const t = await setup(),
      id = await t.create()
    await t.attach(id)
    t.noAck()
    const first = t.route('pty:write', id, 'a')
    const second = t.route('pty:write', id, 'private')
    const rejected = expect(second).rejects.toThrow('Terminal input dropped.')
    await drain()
    if (reason === 'timeout') await vi.advanceTimersByTimeAsync(5000)
    else {
      if (reason === 'reset') {
        t.reset()
        await drain()
        expect(t.inputDropped).toHaveBeenCalledTimes(1)
      }
      if (reason === 'control') {
        t.viewer()
        await drain()
        t.bridge.reconcile()
        expect(t.inputDropped).toHaveBeenCalledTimes(1)
      }
      if (reason === 'disposal') {
        t.bridge.clear()
        expect(t.inputDropped).toHaveBeenCalledTimes(1)
      }
      if (reason === 'generation') await t.reconnect()
      t.raw({
        type: 'terminal.ack',
        terminalId: t.terminalId,
        seq: 1,
        accepted: reason !== 'rejection',
      })
    }
    await drain()
    await first
    await rejected
    expect(t.frames.filter((f) => f.type === 'terminal.input')).toHaveLength(1)
    expect(t.inputDropped.mock.calls).toEqual([[]])
    t.connection.close()
  },
)
it('a dropped active queued write cannot resume if control returns before its ack', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  t.noAck()
  const first = t.route('pty:write', id, 'a')
  const second = t.route('pty:write', id, 'x'.repeat(5000))
  const rejected = expect(second).rejects.toThrow('Terminal input dropped.')
  await drain()
  t.raw({ type: 'terminal.ack', terminalId: t.terminalId, seq: 1, accepted: true })
  await drain()
  t.viewer()
  await drain()
  t.bridge.reconcile()
  await rejected
  t.controller()
  await drain()
  t.raw({ type: 'terminal.ack', terminalId: t.terminalId, seq: 2, accepted: true })
  await drain()
  await first
  expect(t.frames.filter((f) => f.type === 'terminal.input')).toHaveLength(2)
  const next = t.route('pty:write', id, 'next')
  await drain()
  expect(t.frames.filter((f) => f.type === 'terminal.input').at(-1)).toMatchObject({
    seq: 3,
    data: 'next',
  })
  t.raw({ type: 'terminal.ack', terminalId: t.terminalId, seq: 3, accepted: true })
  await drain()
  await next
  expect(t.inputDropped.mock.calls).toEqual([[]])
  t.connection.close()
})
it('64 KiB UTF-8 pending overflow refuses only the new input', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  t.noAck()
  const first = t.route('pty:write', id, 'a')
  const pending = t.route('pty:write', id, '😀'.repeat(16384))
  await expect(t.route('pty:write', id, 'b')).rejects.toThrow('Terminal input refused.')
  for (let seq = 1; seq <= 17; seq++) {
    await drain()
    t.raw({ type: 'terminal.ack', terminalId: t.terminalId, seq, accepted: true })
  }
  await drain()
  await Promise.all([first, pending])
  const input = t.frames.filter((f) => f.type === 'terminal.input')
  expect(input).toHaveLength(17)
  expect(
    input
      .slice(1)
      .map((f) => f.data)
      .join(''),
  ).toBe('😀'.repeat(16384))
  expect(t.inputDropped).not.toHaveBeenCalled()
  t.connection.close()
})
it('attach timeout closes its watch, ignores late reset, and allows fresh attach', async () => {
  const t = await setup(),
    id = await t.create()
  t.pauseReset()
  const attaching = t.route('pty:attach', id)
  const rejected = expect(attaching).rejects.toThrow('Terminal unavailable.')
  await drain()
  await vi.advanceTimersByTimeAsync(5000)
  await rejected
  t.reset('late')
  await drain()
  expect(t.emit).not.toHaveBeenCalled()
  expect(t.frames.filter((f) => f.type === 'unsubscribe')).toHaveLength(1)
  await expect(t.route('pty:write', id, 'a')).rejects.toThrow('Read-only')
  const retry = t.route('pty:attach', id)
  await drain()
  t.reset('fresh')
  await drain()
  expect(await retry).toEqual({ scrollback: 'fresh' })
  t.connection.close()
})
it('an unaccepted input refuses further input until a fresh reset', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  t.noAck()
  t.pauseReset()
  const writing = t.route('pty:write', id, 'lost')
  await drain()
  await vi.advanceTimersByTimeAsync(5000)
  await writing
  const before = t.frames.length
  await expect(t.route('pty:write', id, 'next')).rejects.toThrow('Read-only')
  expect(t.frames.slice(before).filter((f) => f.type === 'terminal.input')).toEqual([])
  t.connection.close()
})
it('a Host restart never rebinds a terminal, even before reconcile runs', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  t.emit.mockClear()
  await t.reconnect(true)
  await drain()
  const before = t.frames.length
  await expect(t.route('pty:write', id, 'after restart')).rejects.toThrow('Not available')
  expect(t.frames.slice(before).filter((f) => f.type === 'terminal.input')).toEqual([])
  expect(t.emit.mock.calls.filter((c) => String(c[1]).startsWith('pty:data:'))).toEqual([])
  t.connection.close()
})
it('another window cannot receive an existing terminal identity from create', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  const routed = t.bridge.route(2, 'pty:create', [`host:${t.lane.laneId}/repo`, 80, 24, 'session'])
  if (!routed) throw new Error('Not routed')
  const pending = routed.result
  await drain()
  await expect(pending).rejects.toThrow('Not available')
  t.connection.close()
})
it('a superseded attach timeout leaves the newer attach synchronized', async () => {
  const t = await setup(),
    id = await t.create()
  t.pauseReset()
  const first = t.route('pty:attach', id).catch((error: Error) => error.message)
  await drain()
  await vi.advanceTimersByTimeAsync(3000)
  // The second subscribe must reach the Host before its reset is sent.
  const second = t.route('pty:attach', id)
  await drain()
  t.reset('fresh')
  await drain()
  expect(await second).toEqual({ scrollback: 'fresh' })
  await vi.advanceTimersByTimeAsync(3000)
  expect(await first).toBe('Terminal unavailable.')
  const writing = t.route('pty:write', id, 'still live')
  await drain()
  await writing
  expect(t.frames.filter((f) => f.type === 'terminal.input')).toMatchObject([
    { seq: 1, data: 'still live' },
  ])
  t.connection.close()
})
it('queued input behind an unaccepted write is rejected at once, never sent', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  t.noAck()
  t.pauseReset()
  const first = t.route('pty:write', id, 'a')
  await drain()
  const queued = t.route('pty:write', id, 'b').catch((error: Error) => error.message)
  await drain()
  await vi.advanceTimersByTimeAsync(5000)
  await first
  expect(await queued).toBe('Terminal input dropped.')
  expect(t.inputDropped).toHaveBeenCalledTimes(1)
  expect(t.frames.filter((f) => f.type === 'terminal.input').map((f) => f.data)).toEqual(['a'])
  t.connection.close()
})
