import type { TestContext } from 'vitest'
import type { ExtensionUIRequest } from '../../rpc'
import { otherClient } from './client'
import { scenario, scenarioFor, type ConformanceKit } from './context'

async function lanesAndAttention(
  { h, lacks, flush, expect, auth, create }: ConformanceKit,
  t: TestContext,
) {
  if (lacks('sessions.read', 'sessions.control'))
    t.skip('requires sessions.read and sessions.control')
  const c = await auth()
  c.send({ type: 'subscribe', id: 'all', topic: 'lanes' })
  await flush()
  const initial = c.frames.find((f) => f.type === 'lanes')
  if (!initial || initial.type !== 'lanes') throw new Error('Missing lanes')
  expect(initial.lanes).toEqual([])
  expect(initial.cursor.seq).toBe(0)
  const laneId = await create(c)
  h.driver.emitTurn(laneId)
  await flush()
  expect(c.frames.some((f) => f.type === 'lanes-delta' && f.upsert[0]?.laneId === laneId)).toBe(
    true,
  )
  const a = c.frames.find((f) => f.type === 'attention')
  expect(a?.type).toBe('attention')
  c.send({ type: 'unsubscribe', id: 'all' })
  c.send({ type: 'subscribe', id: 'again', topic: 'lanes', after: initial.cursor })
  await flush()
  expect(c.frames.filter((f) => f.type === 'attention' && f.id === 'again')).toHaveLength(1)
  await h.driver.restart()
  await flush()
  const next = await auth()
  next.send({ type: 'subscribe', id: 'new', topic: 'lanes', after: initial.cursor })
  await flush()
  expect(next.frames.filter((f) => f.type === 'attention')).toHaveLength(0)
}
async function orderedReplay(
  { h, lacks, flush, expect, auth, create, events, snapshots }: ConformanceKit,
  t: TestContext,
) {
  if (lacks('sessions.read', 'sessions.control'))
    t.skip('requires sessions.read and sessions.control')
  const c = await auth(),
    laneId = await create(c)
  c.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId })
  await flush()
  const start = snapshots(c)[0]
  if (!start) throw new Error('Missing snapshot')
  const sessionId = start.snapshot.state?.sessionId
  expect(sessionId).toEqual(expect.any(String))
  expect(sessionId?.length).toBeGreaterThan(0)
  h.driver.emitTurn(laneId)
  await flush()
  const stream = events(c)
  expect(stream.map((e) => e.cursor.seq)).toEqual(
    stream.map((_, i) => start.snapshot.cursor.seq + i + 1),
  )
  const cut = stream[2]
  if (!cut) throw new Error('No cursor')
  c.send({ type: 'unsubscribe', id: 'lane' })
  c.send({ type: 'subscribe', id: 'resume', topic: 'lane', laneId, after: cut.cursor })
  await flush()
  expect(events(c, 'resume').map((f) => f.event)).toEqual(stream.slice(3).map((f) => f.event))
  expect(snapshots(c)).toHaveLength(1)
  for (let i = 0; i < 5; i++) h.driver.emitTurn(laneId)
  c.send({ type: 'unsubscribe', id: 'resume' })
  c.send({ type: 'subscribe', id: 'old', topic: 'lane', laneId, after: cut.cursor })
  await flush()
  expect(snapshots(c).at(-1)?.reset).toBe(true)
  expect(snapshots(c).at(-1)?.snapshot.state?.sessionId).toBe(sessionId)
  await h.driver.restart()
  await flush()
  const next = await auth()
  next.send({ type: 'subscribe', id: 'new', topic: 'lane', laneId, after: cut.cursor })
  await flush()
  expect(snapshots(next)[0]?.reset).toBe(true)
}
async function uiHydration(
  { h, lacks, flush, expect, auth, create, snapshots }: ConformanceKit,
  t: TestContext,
) {
  if (lacks('sessions.read', 'sessions.control'))
    t.skip('requires sessions.read and sessions.control')
  const a = await auth(),
    laneId = await create(a)
  const status = (key: string, statusText: string | undefined): ExtensionUIRequest => ({
    type: 'extension_ui_request',
    id: 'status',
    method: 'setStatus',
    statusKey: key,
    statusText,
  })
  h.driver.emitUi(laneId, status('one', 'old'))
  h.driver.emitUi(laneId, status('one', 'latest'))
  h.driver.emitUi(laneId, status('two', 'second'))
  h.driver.emitUi(laneId, {
    type: 'extension_ui_request',
    id: 'widget',
    method: 'setWidget',
    widgetKey: 'runs',
    widgetLines: ['latest widget'],
  })
  const b = await auth({ client: otherClient })
  b.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId })
  await flush()
  expect(snapshots(b)[0]?.snapshot.ui).toHaveLength(3)
  expect(snapshots(b)[0]?.snapshot.ui).toContainEqual(status('one', 'latest'))
  h.driver.emitUi(laneId, status('one', undefined))
  h.driver.emitUi(laneId, {
    type: 'extension_ui_request',
    id: 'widget',
    method: 'setWidget',
    widgetKey: 'runs',
    widgetLines: [],
  })
  b.send({ type: 'unsubscribe', id: 'lane' })
  b.send({ type: 'subscribe', id: 'new', topic: 'lane', laneId })
  await flush()
  expect(snapshots(b).at(-1)?.snapshot.ui).toEqual([status('two', 'second')])
}
async function boundedReplay(
  { lacks, replace, flush, expect, auth, create, snapshots }: ConformanceKit,
  t: TestContext,
) {
  if (lacks('sessions.read', 'sessions.control'))
    t.skip('requires sessions.read and sessions.control')
  const h = await replace({ replayBytes: 1, attentionReplay: 1 })
  const c = await auth(),
    laneId = await create(c)
  c.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId })
  c.send({ type: 'subscribe', id: 'all', topic: 'lanes' })
  await flush()
  const lanes = c.frames.find((f) => f.type === 'lanes' && f.id === 'all')
  if (!lanes || lanes.type !== 'lanes') throw new Error('Missing lanes cursor')
  const start = snapshots(c)[0]
  if (!start) throw new Error('Missing snapshot')
  h.driver.emitTurn(laneId)
  h.driver.emitTurn(laneId)
  await flush()
  c.send({ type: 'unsubscribe', id: 'lane' })
  c.send({ type: 'unsubscribe', id: 'all' })
  c.send({
    type: 'subscribe',
    id: 'resume',
    topic: 'lane',
    laneId,
    after: start.snapshot.cursor,
  })
  c.send({ type: 'subscribe', id: 'attention', topic: 'lanes', after: lanes.cursor })
  await flush()
  expect(snapshots(c).at(-1)?.reset).toBe(true)
  expect(c.frames.filter((f) => f.type === 'attention' && f.id === 'attention')).toHaveLength(1)
}
async function oversizeEvent(
  { lacks, replace, flush, expect, auth, create, events, snapshots }: ConformanceKit,
  t: TestContext,
) {
  if (lacks('sessions.read', 'sessions.control'))
    t.skip('requires sessions.read and sessions.control')
  const h = await replace({ outboundFrameBytes: 1800 })
  const c = await auth(),
    laneId = await create(c)
  c.send({ type: 'subscribe', id: 'baseline', topic: 'lanes' })
  await flush()
  const lanes = c.frames.find((f) => f.type === 'lanes' && f.id === 'baseline')
  if (!lanes || lanes.type !== 'lanes') throw new Error('Missing lanes cursor')
  c.send({ type: 'unsubscribe', id: 'baseline' })
  c.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId })
  await flush()
  h.driver.emitUi(laneId, {
    type: 'extension_ui_request',
    id: 'notice',
    method: 'notify',
    message: 'x'.repeat(2000),
  })
  await flush()
  expect(snapshots(c).at(-1)?.reset).toBe(true)
  expect(events(c).some((f) => f.event.kind === 'pi' && f.event.push.kind === 'extension-ui')).toBe(
    false,
  )
  await create(c)
  await create(c)
  await create(c)
  h.driver.emitTurn(laneId)
  c.send({ type: 'subscribe', id: 'all', topic: 'lanes', after: lanes.cursor })
  await flush()
  expect(c.frames).toContainEqual({ type: 'subscribe-failed', id: 'all', code: 'too-large' })
  expect(c.frames.filter((f) => f.type === 'attention' && f.id === 'all')).toEqual([])
  expect(c.socket.isOpen()).toBe(true)
}
async function bufferedReplayAfterOversize(
  { lacks, replace, flush, expect, auth, create, events, snapshots }: ConformanceKit,
  oversizeReset: boolean,
  t: TestContext,
) {
  if (lacks('sessions.read', 'sessions.control'))
    t.skip('requires sessions.read and sessions.control')
  const h = await replace({ outboundFrameBytes: 1800 })
  const c = await auth(),
    laneId = await create(c)
  c.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId })
  await flush()
  const start = snapshots(c)[0]
  if (!start) throw new Error('Missing snapshot')
  c.send({ type: 'unsubscribe', id: 'lane' })
  await flush()
  h.driver.emitUi(laneId, {
    type: 'extension_ui_request',
    id: 'large',
    method: 'notify',
    message: 'x'.repeat(2000),
  })
  h.driver.emitUi(laneId, {
    type: 'extension_ui_request',
    id: 'small',
    method: 'notify',
    message: 'small',
  })
  if (oversizeReset)
    h.driver.emitUi(laneId, {
      type: 'extension_ui_request',
      id: 'status',
      method: 'setStatus',
      statusKey: 'large',
      statusText: 'x'.repeat(2000),
    })
  c.frames.length = 0
  c.send({
    type: 'subscribe',
    id: 'replay',
    topic: 'lane',
    laneId,
    after: start.snapshot.cursor,
  })
  await flush()
  if (oversizeReset) {
    expect(c.frames).toEqual([{ type: 'subscribe-failed', id: 'replay', code: 'too-large' }])
  } else {
    expect(snapshots(c)).toHaveLength(1)
    expect(snapshots(c)[0]?.reset).toBe(true)
    expect(snapshots(c)[0]?.snapshot.cursor.seq).toBeGreaterThan(start.snapshot.cursor.seq)
  }
  expect(events(c, 'replay')).toEqual([])
  h.driver.emitUi(laneId, {
    type: 'extension_ui_request',
    id: 'later',
    method: 'notify',
    message: 'later',
  })
  await flush()
  if (oversizeReset) expect(events(c, 'replay')).toEqual([])
  else {
    const resetSeq = snapshots(c)[0]?.snapshot.cursor.seq
    if (resetSeq === undefined) throw new Error('Missing reset cursor')
    expect(events(c, 'replay').map((f) => f.cursor.seq)).toEqual([resetSeq + 1])
  }
  expect(c.socket.isOpen()).toBe(true)
}

/** Lane lists, snapshots, ordered events, replay and UI hydration, in registration order. */
export const streamScenarios = {
  lanesAndAttention: scenario(
    'lists lanes, publishes deltas, replays attention only within the current epoch',
    lanesAndAttention,
  ),
  orderedReplay: scenario(
    'snapshots, emits ordered events, replays exactly missed events, and resets across a gap or epoch',
    orderedReplay,
  ),
  uiHydration: scenario(
    'hydrates only latest status, widget and title state for a new viewer, and clears keys',
    uiHydration,
  ),
  boundedReplay: scenario(
    'bounds replay by bytes and attention by count, resetting when replay is unavailable',
    boundedReplay,
  ),
  oversizeEvent: scenario(
    'replaces an oversize event with a reset, and ends only an oversize lanes subscription',
    oversizeEvent,
  ),
  bufferedReplayAfterOversize: scenarioFor(
    [false, true],
    'stops buffered replay after an oversized event (oversize reset: %s)',
    bufferedReplayAfterOversize,
  ),
}
