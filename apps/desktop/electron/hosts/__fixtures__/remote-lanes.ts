import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { vi } from 'vitest'
import { createFakeHost, createLoopbackPair } from '@shared/host-protocol-testing'
import { parseClientFrame, parseHostFrame, type ClientFrame } from '@shared/host-protocol'
import type { GrantPayload } from '@shared/host-grant'
import type { SessionPush } from '@shared/models'
import { createHostConnection } from '../connection'
import { createRemoteLanes } from '../remote-lanes'
import { createHostAttention } from '../attention'

export async function drain() {
  for (let i = 0; i < 40; i++) await Promise.resolve()
  await vi.advanceTimersByTimeAsync(0)
}

function createHarnessState(delay: number) {
  const keys = generateKeyPairSync('ed25519')
  const hostId = randomUUID()
  const claims: GrantPayload = {
    v: 1,
    iss: 'http://localhost:12345',
    kid: 'test',
    sub: randomUUID(),
    sid: randomUUID(),
    hostId,
    epoch: 1,
    client: { id: randomUUID(), label: 'Desktop' },
    caps: ['sessions.read', 'sessions.control'],
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    jti: randomBytes(8).toString('hex'),
  }
  const host = createFakeHost({
    expectations: { iss: claims.iss, hostId, owner: claims.sub, epoch: 1 },
    id: randomUUID,
    epoch: () => randomBytes(8).toString('hex'),
    verify: () => true,
    verifyGrant: (token) => ({
      ...claims,
      client: token === 'second' ? { id: secondId, label: 'Other Desktop' } : claims.client,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    }),
    sign: (bytes) => sign(null, bytes, keys.privateKey),
    commandDelayMs: delay,
  })
  const secondId = randomUUID()
  const frames: ClientFrame[] = []
  const pairs: ReturnType<typeof createLoopbackPair>[] = []
  const exported = keys.publicKey.export({ format: 'jwk' }).x
  if (!exported) throw new Error('Missing test key')
  const publicKey: string = exported
  const delivery = { receipts: true, available: true }
  const notify = vi.fn()
  const publish = vi.fn()
  const openRequested = vi.fn()
  const pushes: { channel: string; push: SessionPush }[] = []
  const window = {
    id: 1,
    send: (channel: string, push: SessionPush) => pushes.push({ channel, push }),
    destroyed: () => false,
  }
  const attention = createHostAttention({
    label: () => 'bee1',
    focused: () => false,
    notify,
    publish,
    open: openRequested,
  })
  return {
    host,
    hostId,
    frames,
    pairs,
    publicKey,
    delivery,
    notify,
    publish,
    openRequested,
    pushes,
    window,
    attention,
  }
}
type HarnessState = ReturnType<typeof createHarnessState>

function openSocket(t: HarnessState) {
  if (!t.delivery.available) throw new Error('Offline test transport')
  const pair = createLoopbackPair()
  t.pairs.push(pair)
  pair.server.onMessage((text) => {
    const p = parseClientFrame(text)
    if (p.ok) t.frames.push(p.frame)
  })
  t.host.attach(pair.server)
  return {
    ...pair.client,
    onMessage: (cb: (text: string) => void) =>
      pair.client.onMessage((text) => {
        const frame = parseHostFrame(text)
        if (!t.delivery.receipts && frame.ok && frame.value.type === 'receipt') return
        // Feed text deltas through the real connection and lane projection.
        if (
          frame.ok &&
          frame.value.type === 'event' &&
          frame.value.event.kind === 'pi' &&
          frame.value.event.push.kind === 'extension-ui' &&
          frame.value.event.push.request.method === 'setStatus' &&
          frame.value.event.push.request.statusKey === 'test-delta'
        ) {
          cb(
            JSON.stringify({
              ...frame.value,
              event: {
                kind: 'pi',
                push: {
                  kind: 'event',
                  event: {
                    type: 'message_update',
                    assistantMessageEvent: {
                      type: 'text_delta',
                      contentIndex: 0,
                      delta: 'text',
                    },
                  },
                },
              },
            }),
          )
          return
        }
        cb(text)
      }),
  }
}

function connect(t: HarnessState, token: string) {
  return createHostConnection({
    hostId: t.hostId,
    endpoint: 'https://bee.tail.ts.net:47615',
    socket: async () => openSocket(t),
    grant: async () => ({
      grant: token,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      host: { id: t.hostId, publicKey: t.publicKey, endpoint: 'https://bee.tail.ts.net:47615' },
    }),
    clearGrant: () => {},
    changed: () => {},
    random: () => 1,
    onAttention: (event) => t.attention.receive(t.hostId, event),
  })
}

export async function setup(delay = 0) {
  const t = createHarnessState(delay)
  const c = connect(t, 'first')
  const connection = vi.fn((id: string) => (id === t.hostId ? c : undefined))
  const changed = vi.fn()
  const lanes = createRemoteLanes({
    connection,
    present: (id) => id === t.hostId,
    label: () => 'bee1',
    changed,
  })
  await drain()
  const creation = c.send({ type: 'lane.create', repositoryId: '0123456789abcdef', worktree: null })
  await drain()
  if (delay) await vi.advanceTimersByTimeAsync(delay)
  await drain()
  const created = await creation
  if (created.status !== 'done' || !created.laneId) throw new Error('No test lane')
  return {
    ...t,
    c,
    changed,
    connection,
    lanes,
    laneId: created.laneId,
    connect: (token: string) => connect(t, token),
  }
}
