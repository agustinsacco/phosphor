import type { TestContext } from 'vitest'
import { challenge, otherClient } from './client'
import { scenario, scenarioPendingCap, type ConformanceKit } from './context'

async function malformedInput({ h, replace, flush, expect, auth, receipts }: ConformanceKit) {
  const c = await auth()
  const requestId = h.requestId()
  c.socket.send(
    JSON.stringify({
      type: 'command',
      requestId,
      op: { type: 'new_session' },
    }),
  )
  await flush()
  expect(receipts(c, requestId)).toEqual([{ requestId, status: 'rejected', code: 'unsupported' }])
  expect(c.socket.isOpen()).toBe(true)
  c.socket.send('{')
  await flush()
  expect(c.closed).toEqual([4400])
  await replace({ inboundFrameBytes: 2048 })
  const oversized = await auth()
  oversized.socket.send(' '.repeat(2049))
  await flush()
  expect(oversized.closed).toEqual([4400])
}
async function inFlightCalls(
  { lacks, replace, flush, expect, auth, create }: ConformanceKit,
  t: TestContext,
) {
  if (lacks('sessions.read', 'sessions.control'))
    t.skip('requires sessions.read and sessions.control')
  const pendingCommandsPerConnection = scenarioPendingCap
  await replace({ pendingCommandsPerConnection })
  const boundary = await auth(),
    laneId = await create(boundary)
  const resultsBefore = boundary.frames.filter((f) => f.type === 'result').length
  for (let i = 0; i < pendingCommandsPerConnection; i++)
    boundary.send({ type: 'call', id: 'call' + i, method: 'lane.state', params: { laneId } })
  await flush()
  expect(boundary.socket.isOpen()).toBe(true)
  expect(boundary.frames.filter((f) => f.type === 'result' && f.ok)).toHaveLength(
    resultsBefore + pendingCommandsPerConnection,
  )
  boundary.send({ type: 'call', id: 'released', method: 'lane.state', params: { laneId } })
  await flush()
  expect(boundary.frames.at(-1)).toMatchObject({ type: 'result', id: 'released', ok: true })
  const excess = await auth()
  for (let i = 0; i <= pendingCommandsPerConnection; i++)
    excess.send({ type: 'call', id: 'call' + i, method: 'lane.state', params: { laneId } })
  await flush()
  expect(excess.closed).toEqual([4429])
  expect(boundary.socket.isOpen()).toBe(true)
}
async function subscriptionAndCommandCaps(
  { h, lacks, flush, expect, auth, receipts, create }: ConformanceKit,
  t: TestContext,
) {
  if (lacks('sessions.read', 'sessions.control'))
    t.skip('requires sessions.read and sessions.control')
  const c = await auth(),
    laneId = await create(c)
  for (let i = 0; i < 4; i++) c.send({ type: 'subscribe', id: 's' + i, topic: 'lanes' })
  await flush()
  expect(c.frames.filter((f) => f.type === 'lanes')).toHaveLength(3)
  expect(c.frames.at(-1)).toMatchObject({ type: 'subscribe-failed', code: 'too-many' })
  const ids = [h.requestId(), h.requestId(), h.requestId()]
  for (const requestId of ids)
    c.send({ type: 'command', requestId, laneId, fence: 1, op: { type: 'abort' } })
  await flush()
  expect(receipts(c, ids[2])).toHaveLength(1)
  expect(receipts(c, ids[2])[0]).toMatchObject({
    status: 'rejected',
    code: 'too-many-requests',
  })
  await flush(5)
  expect(receipts(c).filter((r) => r.status === 'done')).toHaveLength(3)
}
async function slowViewer(
  { lacks, replace, flush, expect, auth, create, events, snapshots }: ConformanceKit,
  t: TestContext,
) {
  if (lacks('sessions.read', 'sessions.control'))
    t.skip('requires sessions.read and sessions.control')
  const h = await replace({ sendQueueBytes: 6000 })
  const a = await auth(),
    laneId = await create(a),
    b = await auth({ client: otherClient })
  for (const c of [a, b]) c.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId })
  await flush()
  a.frames.length = 0
  b.frames.length = 0
  a.pause()
  let emittedMessages = 0
  for (let i = 0; i < 20; i++) {
    emittedMessages += h.driver.emitTurn(laneId).messages
    await flush()
  }
  expect(events(b).length).toBeGreaterThan(10)
  a.resume()
  await flush(50)
  expect(snapshots(a)).toHaveLength(1)
  expect(snapshots(a)[0]?.reset).toBe(true)
  expect(snapshots(a)[0]?.snapshot.messages).toHaveLength(emittedMessages)
  b.send({ type: 'unsubscribe', id: 'lane' })
  b.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId })
  await flush()
  expect(snapshots(a)[0]?.snapshot.messages).toEqual(snapshots(b)[0]?.snapshot.messages)
  const cursor = snapshots(a)[0]?.snapshot.cursor.seq ?? -1
  h.driver.emitTurn(laneId)
  await flush()
  expect(
    events(a)
      .filter((e) => e.cursor.seq > cursor)
      .map((e) => e.cursor.seq),
  ).toEqual(
    events(b)
      .filter((e) => e.cursor.seq > cursor)
      .map((e) => e.cursor.seq),
  )
}
async function connectionsPerClient({ replace, flush, expect, client, auth }: ConformanceKit) {
  const h = await replace({ connectionsPerClient: 1 })
  const a = await auth(),
    b = client()
  b.send({ type: 'auth', grant: h.mintGrant(), challenge })
  await flush()
  expect(b.closed).toEqual([4429])
  expect(a.socket.isOpen()).toBe(true)
}
async function oversizeSubscription(
  { lacks, replace, flush, expect, auth, create, events }: ConformanceKit,
  t: TestContext,
) {
  if (lacks('sessions.read', 'sessions.control'))
    t.skip('requires sessions.read and sessions.control')
  const h = await replace({ outboundFrameBytes: 1800 })
  const c = await auth(),
    large = await create(c),
    small = await create(c)
  for (let i = 0; i < 30; i++) {
    h.driver.emitTurn(large)
    await flush()
  }
  c.send({ type: 'subscribe', id: 'large', topic: 'lane', laneId: large })
  c.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId: small })
  c.send({ type: 'call', id: 'messages', method: 'lane.messages', params: { laneId: large } })
  await flush()
  expect(c.frames).toContainEqual({ type: 'subscribe-failed', id: 'large', code: 'too-large' })
  expect(c.frames.find((f) => f.type === 'result' && f.id === 'messages')).toMatchObject({
    ok: false,
    error: { code: 'too-large' },
  })
  h.driver.emitTurn(small)
  await flush()
  expect(events(c).length).toBeGreaterThan(0)
  expect(c.socket.isOpen()).toBe(true)
}

/** Input, in-flight, subscription, send-queue, connection and frame-size caps, in registration order. */
export const limitScenarios = {
  malformedInput: scenario(
    'closes malformed JSON and oversize input, but rejects unknown operations without closing',
    malformedInput,
  ),
  inFlightCalls: scenario('bounds in-flight calls at the configured pending cap', inFlightCalls),
  subscriptionAndCommandCaps: scenario(
    'bounds subscriptions and pending commands at the configured cap',
    subscriptionAndCommandCaps,
  ),
  slowViewer: scenario(
    'recovers a slow viewer with one snapshot, without slowing the other viewer',
    slowViewer,
  ),
  connectionsPerClient: scenario(
    'caps connections per client without affecting existing sockets',
    connectionsPerClient,
  ),
  oversizeSubscription: scenario(
    'fails only an oversize subscription or call, leaving another lane streaming',
    oversizeSubscription,
  ),
}
