import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { vi } from 'vitest'
import { createLoopbackPair } from '@shared/host-protocol-testing'
import {
  helloProofMessage,
  parseClientFrame,
  type ClientFrame,
  type HostFrame,
  type LaneSummary,
} from '@shared/host-protocol'
import type { TerminalFrame } from '@shared/host-protocol-terminals'
import { createHostConnection } from '../connection'
import { createRemoteTerminals } from '../terminals'

export const drain = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}

function createHarnessState() {
  const hostId = randomUUID(),
    clientId = randomUUID(),
    terminalId = randomUUID()
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ format: 'jwk' }).x
  if (!publicKey) throw new Error('Missing test key')
  const lane: LaneSummary = {
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
  const caps: ('terminal' | 'sessions.read' | 'sessions.control')[] = [
    'terminal',
    'sessions.read',
    'sessions.control',
  ]
  const frames: ClientFrame[] = []
  return {
    hostId,
    clientId,
    terminalId,
    keys,
    publicKey,
    lane,
    caps,
    status: 'running' as 'running' | 'interrupted',
    frames,
    epoch: '1111111111111111',
    inputSeq: 0,
    outputSeq: 0,
    ack: true,
    autoReceipt: true,
    current: true,
    autoReset: true,
    empty: false,
    pair: createLoopbackPair(),
    subscription: '',
  }
}
type HarnessState = ReturnType<typeof createHarnessState>

function send(t: HarnessState, frame: HostFrame) {
  t.pair.server.send(JSON.stringify(frame))
}
function reset(t: HarnessState, data = 'prompt') {
  send(t, {
    type: 'terminal.reset',
    id: t.subscription,
    terminalId: t.terminalId,
    epoch: t.epoch,
    seq: t.outputSeq,
    data,
    inputSeq: t.inputSeq,
    status: t.status,
  })
}

function ready(t: HarnessState, challenge: string) {
  send(t, {
    type: 'ready',
    protocolVersion: 1,
    hello: {
      hostId: t.hostId,
      hostVersion: '1.0.0',
      protocolVersion: 1,
      runtimeEpoch: t.epoch,
      capabilities: t.caps,
    },
    proof: sign(
      null,
      Buffer.from(helloProofMessage(t.hostId, t.epoch, challenge)),
      t.keys.privateKey,
    ).toString('base64url'),
    connectionId: '2222222222222222',
    grantExpiresAt: new Date(Date.now() + 300000).toISOString(),
    client: { id: t.clientId, label: 'Test' },
    capabilities: t.caps,
  })
}

function refresh(t: HarnessState, id = 'lanes') {
  send(t, {
    type: 'lanes',
    id,
    cursor: { epoch: t.epoch, seq: 0 },
    repositories: [],
    lanes: [t.lane],
  })
}

function receive(t: HarnessState, text: string) {
  const parsed = parseClientFrame(text)
  if (!parsed.ok) throw new Error('Bad client frame')
  const f = parsed.frame
  t.frames.push(f)
  if (f.type === 'auth') ready(t, f.challenge ?? '')
  else if (f.type === 'subscribe' && f.topic === 'lanes') refresh(t, f.id)
  else if (f.type === 'subscribe' && f.topic === 'terminal') {
    t.subscription = f.id
    if (t.autoReset) reset(t)
  } else if (f.type === 'command' && t.autoReceipt)
    send(t, {
      type: 'receipt',
      receipt: {
        requestId: f.requestId,
        status: 'done',
        laneId: t.lane.laneId,
        data:
          f.op.type === 'terminal.create' || f.op.type === 'provider.login'
            ? { terminalId: t.terminalId }
            : undefined,
      },
    })
  else if (f.type === 'call')
    send(t, {
      type: 'result',
      id: f.id,
      ok: true,
      data: t.empty ? [] : [{ terminalId: t.terminalId, laneId: t.lane.laneId, status: t.status }],
    })
  else if (f.type === 'terminal.input' && t.ack) {
    t.inputSeq = f.seq
    send(t, { type: 'terminal.ack', terminalId: t.terminalId, seq: f.seq, accepted: true })
  }
}

function connect(t: HarnessState, log: Parameters<typeof createHostConnection>[0]['log']) {
  return createHostConnection({
    log,
    hostId: t.hostId,
    endpoint: 'https://bee.tail.ts.net:47615',
    grant: async () => ({
      grant: 'test-grant',
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      host: { id: t.hostId, publicKey: t.publicKey, endpoint: 'https://bee.tail.ts.net:47615' },
    }),
    socket: async () => {
      t.pair = createLoopbackPair()
      t.pair.server.onMessage((text) => receive(t, text))
      return t.pair.client
    },
    clearGrant: () => {},
    changed: () => {},
    random: () => 1,
  })
}

function controlActions(t: HarnessState) {
  return {
    pauseReset: () => {
      t.autoReset = false
    },
    setCurrent: () => {
      t.current = false
    },
    controller: () => {
      t.lane = {
        ...t.lane,
        control: {
          ...t.lane.control,
          controller: { clientId: t.clientId, label: 'Test', connected: true },
        },
      }
      refresh(t)
    },
    viewer: () => {
      t.lane = { ...t.lane, control: { ...t.lane.control, controller: null } }
      refresh(t)
    },
    empty: () => {
      t.empty = true
    },
    loseCapability: (cap: 'terminal' | 'sessions.control' = 'terminal') => {
      t.caps = t.caps.filter((c) => c !== cap)
    },
    delayReceipt: () => {
      t.autoReceipt = false
    },
    noAck: () => {
      t.ack = false
    },
  }
}

function transportActions(t: HarnessState) {
  return {
    reset: (data = 'prompt') => reset(t, data),
    receipt: () => {
      const f = [...t.frames].reverse().find((f) => f.type === 'command')
      if (f?.type === 'command')
        send(t, {
          type: 'receipt',
          receipt: { requestId: f.requestId, status: 'done', data: { terminalId: t.terminalId } },
        })
    },
    output: (seq: number, data: string) => {
      t.outputSeq = seq
      send(t, {
        type: 'terminal.output',
        id: t.subscription,
        terminalId: t.terminalId,
        epoch: t.epoch,
        seq,
        data,
      })
    },
    interrupt: () => {
      t.status = 'interrupted'
      reset(t)
    },
    disconnect: () => t.pair.server.close(1000, 'test'),
    reconnect: async (restart = false) => {
      if (restart) t.epoch = '3333333333333333'
      t.pair.server.close(1000, 'test')
      await vi.advanceTimersByTimeAsync(1000)
      await drain()
    },
    raw: (f: TerminalFrame) => send(t, f),
  }
}

function routes(bridge: ReturnType<typeof createRemoteTerminals>, hostId: string) {
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
  return { route, create, attach }
}

export async function setup() {
  const t = createHarnessState()
  const log = vi.fn()
  const inputDropped = vi.fn()
  const connection = connect(t, log)
  await drain()
  const emit = vi.fn()
  const bridge = createRemoteTerminals({
    connection: () => (t.current ? connection : undefined),
    inputDropped,
    clientId: () => t.clientId,
    emit,
    lane: () => ({ hostId: t.hostId, laneId: t.lane.laneId, connection, current: () => t.current }),
  })
  return {
    hostId: t.hostId,
    log,
    inputDropped,
    connection,
    bridge,
    frames: t.frames,
    emit,
    terminalId: t.terminalId,
    lane: t.lane,
    ...routes(bridge, t.hostId),
    ...controlActions(t),
    ...transportActions(t),
  }
}
