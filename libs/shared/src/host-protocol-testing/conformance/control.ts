import type { TestContext } from 'vitest'
import type { LaneOp } from '../../host-protocol'
import { otherClient } from './client'
import { scenario, type ConformanceKit } from './context'

async function capabilityAndCalls(
  { lacks, flush, expect, auth, create, command }: ConformanceKit,
  t: TestContext,
) {
  if (lacks('sessions.read', 'sessions.control'))
    t.skip('requires sessions.read and sessions.control')
  const c = await auth(),
    laneId = await create(c),
    viewer = await auth({ client: otherClient, caps: ['sessions.read'] })
  expect(await command(viewer, laneId, { type: 'control.take' })).toMatchObject({
    status: 'rejected',
    code: 'forbidden',
  })
  const resultStart = c.frames.length
  for (const method of [
    'host.repositories',
    'lane.state',
    'lane.messages',
    'lane.stats',
    'lane.models',
    'lane.commands',
  ]) {
    c.send({ type: 'call', id: method.replace('.', '_'), method, params: { laneId } })
    await flush()
  }
  c.send({ type: 'call', id: 'unsupported', method: 'other.method', params: {} })
  await flush()
  expect(c.frames.slice(resultStart).filter((f) => f.type === 'result' && f.ok)).toHaveLength(6)
  expect(c.frames.at(-1)).toMatchObject({
    type: 'result',
    ok: false,
    error: { code: 'unsupported' },
  })
}
async function takeover(
  { h, lacks, flush, expect, auth, create, command, events }: ConformanceKit,
  t: TestContext,
) {
  if (lacks('sessions.read', 'sessions.control'))
    t.skip('requires sessions.read and sessions.control')
  const a = await auth(),
    laneId = await create(a),
    b = await auth({ client: otherClient })
  for (const c of [a, b]) c.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId })
  await flush()
  expect(await command(b, laneId, { type: 'abort' })).toMatchObject({
    status: 'rejected',
    code: 'not-controller',
    control: { controller: { clientId: h.claims.client.id } },
  })
  expect(await command(b, laneId, { type: 'control.take' })).toMatchObject({
    status: 'done',
    fence: 2,
  })
  const ae = events(a).find((e) => e.event.kind === 'control'),
    be = events(b).find((e) => e.event.kind === 'control')
  expect(ae?.cursor).toEqual(be?.cursor)
  expect(ae?.event).toEqual(be?.event)
  expect(await command(a, laneId, { type: 'abort' }, 1)).toMatchObject({
    status: 'rejected',
    code: 'stale-fence',
  })
  expect(await command(b, laneId, { type: 'control.release' }, 2)).toMatchObject({
    status: 'done',
    fence: 3,
  })
  a.frames.length = 0
  h.driver.emitUi(laneId, {
    type: 'extension_ui_request',
    id: 'notice',
    method: 'notify',
    message: 'Unrelated activity',
  })
  expect(await command(a, laneId, { type: 'prompt', message: 'Hello' }, 3)).toMatchObject({
    status: 'done',
    fence: 4,
  })
  const stream = events(a)
  const controlIndex = stream.findIndex((e) => e.event.kind === 'control')
  const piIndex = stream.findIndex((e) => e.event.kind === 'pi' && e.event.push.kind === 'event')
  expect(controlIndex).toBeGreaterThanOrEqual(0)
  expect(piIndex).toBeGreaterThan(controlIndex)
}
async function dialogAnswer(
  { h, lacks, flush, expect, auth, create, command, events }: ConformanceKit,
  t: TestContext,
) {
  if (lacks('sessions.read', 'sessions.control'))
    t.skip('requires sessions.read and sessions.control')
  const a = await auth(),
    laneId = await create(a),
    b = await auth({ client: otherClient })
  a.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId })
  await flush()
  h.driver.openDialog(laneId)
  await flush()
  const op: LaneOp = {
    type: 'extension_ui_response',
    response: { type: 'extension_ui_response', id: 'dialog', confirmed: true },
  }
  expect(await command(b, laneId, op)).toMatchObject({
    status: 'rejected',
    code: 'not-controller',
  })
  expect(await command(a, laneId, op)).toMatchObject({ status: 'done' })
  expect(
    events(a).some((f) => f.event.kind === 'dialog-resolved' && f.event.dialogId === 'dialog'),
  ).toBe(true)
}
async function stopAndResume(
  { h, lacks, flush, expect, auth, create, command, events, snapshots }: ConformanceKit,
  t: TestContext,
) {
  if (lacks('sessions.read', 'sessions.control'))
    t.skip('requires sessions.read and sessions.control')
  const c = await auth(),
    laneId = await create(c)
  expect(await command(c, laneId, { type: 'lane.stop' })).toMatchObject({ status: 'done' })
  expect(await command(c, laneId, { type: 'prompt', message: 'Hello' })).toMatchObject({
    status: 'rejected',
    code: 'lane-stopped',
  })
  expect(await command(c, laneId, { type: 'lane.resume' })).toMatchObject({ status: 'done' })
  h.driver.emitTurn(laneId)
  expect(await command(c, laneId, { type: 'lane.markRead', upTo: 999 })).toMatchObject({
    status: 'done',
  })
  c.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId })
  await flush()
  expect(snapshots(c)[0]?.snapshot.summary).toMatchObject({ attention: 1, read: 1 })
  h.driver.failLane(laneId)
  h.driver.emitUi(laneId, {
    type: 'extension_ui_request',
    id: 'notice',
    method: 'notify',
    message: 'Unrelated activity',
  })
  await flush()
  expect(
    events(c).findLast((frame) => frame.laneId === laneId && frame.event.kind === 'summary')?.event,
  ).toMatchObject({
    kind: 'summary',
    summary: { activity: 'failed' },
  })
}
async function controllerReconnect(
  { h, lacks, flush, expect, auth, create, command, events }: ConformanceKit,
  t: TestContext,
) {
  if (lacks('sessions.read', 'sessions.control'))
    t.skip('requires sessions.read and sessions.control')
  const a = await auth(),
    laneId = await create(a),
    b = await auth({ client: otherClient })
  b.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId })
  await flush()
  a.sever()
  await flush()
  expect(events(b).find((e) => e.event.kind === 'control')?.event).toMatchObject({
    kind: 'control',
    control: { fence: 1, controller: { connected: false } },
  })
  const reconnectStart = b.frames.length
  const next = await auth()
  // Unrelated activity may follow the control change before it is inspected.
  h.driver.emitUi(laneId, {
    type: 'extension_ui_request',
    id: 'notice',
    method: 'notify',
    message: 'Reconnected',
  })
  await flush()
  expect(
    b.frames
      .slice(reconnectStart)
      .findLast(
        (frame) =>
          frame.type === 'event' && frame.laneId === laneId && frame.event.kind === 'control',
      ),
  ).toMatchObject({
    type: 'event',
    event: {
      kind: 'control',
      control: { fence: 1, controller: { connected: true } },
    },
  })
  expect(await command(next, laneId, { type: 'abort' })).toMatchObject({
    status: 'done',
    fence: 1,
  })
}

async function laneMarks(
  { h, lacks, flush, expect, auth, create, command, events }: ConformanceKit,
  t: TestContext,
) {
  if (lacks('sessions.read', 'sessions.control'))
    t.skip('requires sessions.read and sessions.control')
  const a = await auth(),
    laneId = await create(a),
    b = await auth({ client: otherClient })
  b.send({ type: 'subscribe', id: 'all', topic: 'lanes' })
  b.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId })
  await flush()
  const upserted = () =>
    b.frames.findLast((f) => f.type === 'lanes-delta' && f.upsert.some((l) => l.laneId === laneId))
  expect(
    await command(b, laneId, { type: 'lane.marks', pinned: true, marker: '🦊' }, 99),
  ).toMatchObject({ status: 'done' })
  expect(upserted()).toMatchObject({
    upsert: [
      {
        laneId,
        pinned: true,
        marker: '🦊',
        control: { fence: 1, controller: { clientId: h.claims.client.id } },
      },
    ],
  })
  expect(events(b).some((e) => e.event.kind === 'control')).toBe(false)
  expect(await command(a, laneId, { type: 'lane.stop' })).toMatchObject({ status: 'done' })
  expect(await command(b, laneId, { type: 'lane.marks', marker: null })).toMatchObject({
    status: 'done',
  })
  const cleared = upserted()
  expect(cleared?.type === 'lanes-delta' && cleared.upsert[0]).toMatchObject({ pinned: true })
  expect(cleared?.type === 'lanes-delta' && cleared.upsert[0]).not.toHaveProperty('marker')
  const viewer = await auth({ client: otherClient, caps: ['sessions.read'] })
  expect(await command(viewer, laneId, { type: 'lane.marks', pinned: false })).toMatchObject({
    status: 'rejected',
    code: 'forbidden',
  })
}

/** Control capability, takeover fences, dialogs, stop/resume and controller presence, in registration order. */
export const controlScenarios = {
  capabilityAndCalls: scenario(
    'refuses control without the capability and runs the M2 calls',
    capabilityAndCalls,
  ),
  takeover: scenario(
    'serializes takeover for all viewers, fences the old controller, releases and acquires before pi events',
    takeover,
  ),
  dialogAnswer: scenario(
    'rejects a viewer dialog answer and resolves the controller answer in the stream',
    dialogAnswer,
  ),
  stopAndResume: scenario(
    'stops and resumes lanes, marks attention read, and exposes failure',
    stopAndResume,
  ),
  controllerReconnect: scenario(
    'keeps controller ownership across disconnect and reconnect without changing its fence',
    controllerReconnect,
  ),
  laneMarks: scenario(
    'sets pins and markers from any controlling client, unfenced and on a stopped lane, and publishes them',
    laneMarks,
  ),
}
