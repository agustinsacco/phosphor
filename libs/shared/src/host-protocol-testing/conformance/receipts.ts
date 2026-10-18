import type { TestContext } from 'vitest'
import { HOST_LIMITS, type ClientFrame } from '../../host-protocol'
import { otherClient } from './client'
import { scenario, scenarioFor, type ConformanceKit } from './context'

async function deduplication(
  { h, lacks, flush, expect, auth, receipts, create }: ConformanceKit,
  t: TestContext,
) {
  if (lacks('sessions.read', 'sessions.control'))
    t.skip('requires sessions.read and sessions.control')
  const c = await auth(),
    laneId = await create(c),
    requestId = h.requestId()
  const frame: ClientFrame = {
    type: 'command',
    requestId,
    laneId,
    fence: 1,
    op: { type: 'prompt', message: 'Hello' },
  }
  const before = h.driver.executions()
  c.send(frame)
  c.send(frame)
  await flush()
  expect(receipts(c, requestId).map((r) => r.status)).toEqual(['pending'])
  await flush(5)
  expect(receipts(c, requestId).map((r) => r.status)).toEqual(['pending', 'done'])
  expect(h.driver.executions()).toBe(before + 1)
  const observer = await auth()
  c.send(frame)
  await flush()
  expect(receipts(c, requestId).filter((r) => r.status === 'done')).toHaveLength(2)
  expect(receipts(observer, requestId)).toEqual([])
  expect(h.driver.executions()).toBe(before + 1)
  c.send({ ...frame, op: { type: 'abort' } })
  await flush()
  expect(receipts(c, requestId).at(-1)).toMatchObject({ status: 'rejected', code: 'conflict' })
}
async function resendOnNewSocket(
  { h, lacks, flush, expect, auth, receipts, create }: ConformanceKit,
  t: TestContext,
) {
  if (lacks('sessions.read', 'sessions.control'))
    t.skip('requires sessions.read and sessions.control')
  const c = await auth(),
    laneId = await create(c),
    requestId = h.requestId()
  const frame: ClientFrame = {
    type: 'command',
    requestId,
    laneId,
    fence: 1,
    op: { type: 'prompt', message: 'Hello' },
  }
  const before = h.driver.executions()
  c.send(frame)
  await flush()
  c.sever()
  await flush()
  const next = await auth()
  next.send(frame)
  await flush()
  expect(receipts(next, requestId).map((r) => r.status)).toEqual(['pending'])
  await flush(5)
  expect(receipts(next, requestId).map((r) => r.status)).toEqual(['pending', 'done'])
  expect(h.driver.executions()).toBe(before + 1)
}
async function answerDeadline(
  { lacks, replace, flush, expect, auth, receipts, create }: ConformanceKit,
  commandDelayMs: number,
  t: TestContext,
) {
  if (lacks('sessions.read', 'sessions.control'))
    t.skip('requires sessions.read and sessions.control')
  const h = await replace({ commandDelayMs })
  const c = await auth(),
    laneId = await create(c),
    requestId = h.requestId()
  const frame: ClientFrame = {
    type: 'command',
    requestId,
    laneId,
    fence: 1,
    op: { type: 'prompt', message: 'Hello' },
  }
  c.send(frame)
  c.send(frame)
  await flush()
  expect(receipts(c, requestId).map((r) => r.status)).toEqual(['pending'])
  await flush(HOST_LIMITS.commandAnswerMs - 2)
  expect(receipts(c, requestId).map((r) => r.status)).toEqual(['pending'])
  await flush(1)
  const status = commandDelayMs < HOST_LIMITS.commandAnswerMs ? 'done' : 'unknown'
  expect(receipts(c, requestId).map((r) => r.status)).toEqual(
    status === 'done' ? ['pending', 'done'] : ['pending'],
  )
  await flush(1)
  expect(receipts(c, requestId).map((r) => r.status)).toEqual(['pending', status])
  await flush(2)
  expect(receipts(c, requestId).map((r) => r.status)).toEqual(['pending', status])
  const lookup = await auth()
  lookup.send({ type: 'receipt-status', requestId })
  await flush()
  expect(receipts(lookup, requestId)).toMatchObject([{ status }])
}
async function unknownReceipts(
  { h, lacks, flush, expect, auth, receipts, create, command }: ConformanceKit,
  t: TestContext,
) {
  if (lacks('sessions.read', 'sessions.control'))
    t.skip('requires sessions.read and sessions.control')
  const c = await auth(),
    laneId = await create(c),
    missing = h.requestId()
  c.send({ type: 'receipt-status', requestId: missing })
  await flush()
  expect(receipts(c, missing)).toEqual([{ requestId: missing, status: 'unknown' }])
  const requestId = h.requestId()
  c.send({
    type: 'command',
    requestId,
    laneId,
    fence: 1,
    op: { type: 'prompt', message: 'Hello' },
  })
  await flush()
  const other = await auth({ client: otherClient })
  other.send({ type: 'receipt-status', requestId })
  await flush()
  expect(receipts(other, requestId)).toEqual([{ requestId, status: 'unknown' }])
  await h.driver.restart()
  await flush()
  const next = await auth()
  next.send({ type: 'receipt-status', requestId })
  await flush()
  expect(receipts(next, requestId)).toEqual([{ requestId, status: 'unknown' }])
  const done = await command(next, laneId, { type: 'lane.markRead', upTo: 0 })
  const reconnect = await auth()
  reconnect.send({ type: 'receipt-status', requestId: done.requestId })
  await flush()
  expect(receipts(reconnect, done.requestId)).toEqual([done])
}
async function interruptedCommand(
  { h, lacks, flush, expect, auth, receipts, create, events }: ConformanceKit,
  t: TestContext,
) {
  if (lacks('sessions.read', 'sessions.control'))
    t.skip('requires sessions.read and sessions.control')
  const c = await auth(),
    laneId = await create(c),
    requestId = h.requestId()
  c.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId })
  c.send({
    type: 'command',
    requestId,
    laneId,
    fence: 1,
    op: { type: 'prompt', message: 'Hello' },
  })
  await flush()
  h.driver.failLane(laneId)
  h.driver.emitUi(laneId, {
    type: 'extension_ui_request',
    id: 'notice',
    method: 'notify',
    message: 'Unrelated activity',
  })
  await flush(5)
  expect(receipts(c, requestId)).toEqual([{ requestId, status: 'unknown' }])
  expect(
    events(c).findLast((frame) => frame.laneId === laneId && frame.event.kind === 'summary')?.event,
  ).toMatchObject({
    kind: 'summary',
    summary: { activity: 'failed' },
  })
}
async function terminalPerSocket(
  { h, lacks, flush, expect, auth, receipts, create }: ConformanceKit,
  t: TestContext,
) {
  if (lacks('sessions.read', 'sessions.control'))
    t.skip('requires sessions.read and sessions.control')
  const a = await auth(),
    laneId = await create(a),
    b = await auth(),
    requestId = h.requestId()
  const frame: ClientFrame = {
    type: 'command',
    requestId,
    laneId,
    fence: 1,
    op: { type: 'prompt', message: 'Hello' },
  }
  const before = h.driver.executions()
  a.send(frame)
  b.send({ type: 'receipt-status', requestId })
  await flush()
  expect(receipts(b, requestId).map((r) => r.status)).toEqual(['pending'])
  await flush(5)
  for (const c of [a, b])
    expect(receipts(c, requestId).filter((r) => r.status === 'done')).toHaveLength(1)
  for (const [sender, other] of [
    [a, b],
    [b, a],
  ]) {
    if (!sender || !other) throw new Error('Missing viewer')
    const oldSender = receipts(sender, requestId).length
    const oldOther = receipts(other, requestId).length
    sender.send(frame)
    sender.send({ type: 'receipt-status', requestId })
    await flush()
    expect(
      receipts(sender, requestId)
        .slice(oldSender)
        .map((r) => r.status),
    ).toEqual(['done', 'done'])
    expect(receipts(other, requestId)).toHaveLength(oldOther)
    expect(h.driver.executions()).toBe(before + 1)
  }
}
async function receiptCaps(
  { lacks, replace, flush, expect, auth, receipts, create, command }: ConformanceKit,
  t: TestContext,
) {
  if (lacks('sessions.read', 'sessions.control'))
    t.skip('requires sessions.read and sessions.control')
  const h = await replace({ receiptsKept: 1, receiptTtlMs: 20, commandDelayMs: 5 })
  const c = await auth(),
    laneId = await create(c),
    first = h.requestId(),
    second = h.requestId()
  c.send({ type: 'command', requestId: first, laneId, fence: 1, op: { type: 'abort' } })
  c.send({ type: 'command', requestId: second, laneId, fence: 1, op: { type: 'abort' } })
  await flush()
  expect(receipts(c, second)).toMatchObject([{ status: 'rejected', code: 'busy' }])
  await flush(5)
  const reconnect = await auth()
  reconnect.send({ type: 'receipt-status', requestId: first })
  await flush()
  expect(receipts(reconnect, first)).toMatchObject([{ status: 'done' }])
  // Count pruning breaks same-millisecond ties by request id, not admission order.
  await flush(1)
  await command(c, laneId, { type: 'lane.markRead', upTo: 0 })
  const lookup = await auth()
  lookup.send({ type: 'receipt-status', requestId: first })
  await flush()
  expect(receipts(lookup, first)).toEqual([{ requestId: first, status: 'unknown' }])
  const latest = await command(c, laneId, { type: 'abort' })
  await flush(20)
  const beforeExpiry = await auth()
  beforeExpiry.send({ type: 'receipt-status', requestId: latest.requestId })
  await flush()
  expect(receipts(beforeExpiry, latest.requestId)).toEqual([latest])
  await flush(1)
  lookup.send({ type: 'receipt-status', requestId: latest.requestId })
  await flush()
  expect(receipts(lookup, latest.requestId)).toEqual([
    { requestId: latest.requestId, status: 'unknown' },
  ])
}
async function startedReceiptTtl(
  { lacks, replace, flush, expect, auth, receipts, create }: ConformanceKit,
  t: TestContext,
) {
  if (lacks('sessions.read', 'sessions.control'))
    t.skip('requires sessions.read and sessions.control')
  const h = await replace({ receiptTtlMs: 20, commandDelayMs: 25 })
  const c = await auth(),
    laneId = await create(c),
    requestId = h.requestId()
  c.send({ type: 'command', requestId, laneId, fence: 1, op: { type: 'abort' } })
  await flush(21)
  const pending = await auth()
  pending.send({ type: 'receipt-status', requestId })
  await flush()
  expect(receipts(pending, requestId)).toEqual([{ requestId, status: 'pending' }])
  await flush(4)
  const terminal = receipts(c, requestId).at(-1)
  expect(terminal?.status).toBe('done')
  await flush(20)
  const boundary = await auth()
  boundary.send({ type: 'receipt-status', requestId })
  await flush()
  expect(receipts(boundary, requestId)).toEqual([terminal])
  await flush(1)
  const expired = await auth()
  expired.send({ type: 'receipt-status', requestId })
  await flush()
  expect(receipts(expired, requestId)).toEqual([{ requestId, status: 'unknown' }])
}

/** Command admission, deduplication, terminal receipts and receipt retention, in registration order. */
export const receiptScenarios = {
  deduplication: scenario(
    'deduplicates running commands, sends pending then one terminal receipt, and rejects conflicting reuse',
    deduplication,
  ),
  resendOnNewSocket: scenario(
    'resends on a new socket mid-command without executing twice',
    resendOnNewSocket,
  ),
  answerDeadline: scenarioFor(
    [HOST_LIMITS.commandAnswerMs - 1, HOST_LIMITS.commandAnswerMs + 1],
    'answers once when pi completes at %i ms around the uncertainty deadline',
    answerDeadline,
  ),
  unknownReceipts: scenario(
    'returns unknown for unrecorded, pruned, another client, and interrupted requests; returns stored results',
    unknownReceipts,
  ),
  interruptedCommand: scenario(
    'reports an interrupted running command as unknown without resurrecting a failed lane',
    interruptedCommand,
  ),
  terminalPerSocket: scenario(
    'delivers a terminal receipt to each waiting socket of the same client only once',
    terminalPerSocket,
  ),
  receiptCaps: scenario(
    'caps finished and started receipts separately, prunes by age and does not leak pruned results',
    receiptCaps,
  ),
  startedReceiptTtl: scenario(
    'keeps started receipts past the TTL and does not extend terminal retention on reads',
    startedReceiptTtl,
  ),
}
