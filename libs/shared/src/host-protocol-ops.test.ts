import { describe, expect, it } from 'vitest'
import { parseClientFrame } from './host-protocol'
import {
  OPS_LIMITS,
  isOpName,
  parseOpsJobData,
  parseOpsRunOp,
  parseOpsRunRequest,
  parseOpsRunResult,
} from './host-protocol-ops'

const UUID = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000002'
const DIGEST = 'ab'.repeat(32)
const REQUEST = {
  op: 'archive.purge',
  args: { ids: [UUID] },
  reason: 'Clean up',
  actor: { kind: 'agent', lane: 'host:x/lane:y', title: 'Lane' },
  confirm: { confirmId: UUID, digest: DIGEST },
  batch: { id: OTHER, index: 3, size: 4 },
  page: 'next_page-1',
} as const

describe('parseOpsRunRequest', () => {
  it('keeps a full request unchanged and a minimal one minimal', () => {
    expect(parseOpsRunRequest(REQUEST)).toStrictEqual(REQUEST)
    expect(parseOpsRunRequest({ op: 'help', args: {} })).toStrictEqual({ op: 'help', args: {} })
  })

  it('takes op names of one to three camelCase words within 64 characters', () => {
    for (const name of ['help', 'lane.list', 'machine.settings.read', `a${'b'.repeat(63)}`])
      expect(isOpName(name), name).toBe(true)
    for (const name of ['', 'Lane', 'lane.', 'a.b.c.d', 'lane-list', 'lane..list', 'a'.repeat(65)])
      expect(isOpName(name), name).toBe(false)
  })

  it('refuses unknown keys, bad nested refs and oversized fields', () => {
    const bad = [
      { ...REQUEST, extra: 1 },
      { ...REQUEST, op: 'Lane.list' },
      { ...REQUEST, args: [] },
      { ...REQUEST, reason: 'x'.repeat(OPS_LIMITS.reasonChars + 1) },
      { ...REQUEST, reason: '' },
      { ...REQUEST, actor: { kind: 'user' } },
      { ...REQUEST, actor: { kind: 'agent', extra: true } },
      { ...REQUEST, actor: { kind: 'agent', title: ' padded' } },
      { ...REQUEST, confirm: { confirmId: UUID } },
      { ...REQUEST, confirm: { confirmId: UUID, digest: 'AB'.repeat(32) } },
      { ...REQUEST, batch: { id: OTHER, index: 4, size: 4 } },
      { ...REQUEST, batch: { id: OTHER, index: 0, size: OPS_LIMITS.hostsPerBatch + 1 } },
      { ...REQUEST, page: 'a b' },
      { ...REQUEST, page: 'a'.repeat(OPS_LIMITS.pageChars + 1) },
    ]
    for (const value of bad) expect(parseOpsRunRequest(value), JSON.stringify(value)).toBeNull()
  })

  it('bounds the args JSON by UTF-8 bytes, content included', () => {
    const fits = 'x'.repeat(OPS_LIMITS.argsBytes - '{"content":""}'.length)
    expect(parseOpsRunRequest({ op: 'files.write', args: { content: fits } })).not.toBeNull()
    expect(parseOpsRunRequest({ op: 'files.write', args: { content: `${fits}x` } })).toBeNull()
    expect(
      parseOpsRunRequest({ op: 'files.write', args: { content: `${fits.slice(1)}é` } }),
    ).toBeNull()
  })
})

describe('the ops.run command', () => {
  it('is a laneless, unfenced command op', () => {
    const op = { type: 'ops.run', ...REQUEST }
    const command = { type: 'command', requestId: UUID, op }
    expect(parseOpsRunOp(op)).toStrictEqual(op)
    expect(parseClientFrame(JSON.stringify(command))).toStrictEqual({ ok: true, frame: command })
    for (const extra of [{ laneId: OTHER }, { fence: 1 }])
      expect(parseClientFrame(JSON.stringify({ ...command, ...extra }))).toMatchObject({
        ok: false,
        reply: { code: 'bad-request' },
      })
  })

  it('refuses an invalid request as bad-request, not unsupported', () => {
    const command = { type: 'command', requestId: UUID, op: { type: 'ops.run', op: 'Bad' } }
    expect(parseClientFrame(JSON.stringify(command))).toStrictEqual({
      ok: false,
      reason: 'command',
      reply: { kind: 'receipt', requestId: UUID, code: 'bad-request' },
    })
  })

  it('is a valid call method name for reads', () => {
    const call = { type: 'call', id: 'c1', method: 'ops.run', params: REQUEST }
    expect(parseClientFrame(JSON.stringify(call))).toStrictEqual({ ok: true, frame: call })
  })
})

describe('parseOpsRunResult', () => {
  const ok = {
    status: 'ok',
    text: 'Done',
    applies: 'now',
    data: { a: 1 },
    next: 'n',
    undo: true,
    auditId: 'a1',
  }
  const item = { hostId: null, op: 'archive.purge', ids: [UUID], labels: ['Lane'] }
  const confirm = {
    status: 'confirm',
    confirmId: UUID,
    digest: DIGEST,
    title: 'Purge archives',
    message: 'Purge 1 archive on 2 machines?',
    items: [item, { ...item, hostId: OTHER, confirmId: OTHER, digest: DIGEST }],
    expiresAt: 1_000,
  }
  const denied = { status: 'denied', code: 'not-controller', text: 'Desktop controls this lane.' }

  it('keeps each status unchanged and drops unknown keys', () => {
    for (const result of [ok, confirm, denied]) {
      expect(parseOpsRunResult(result)).toStrictEqual(result)
      expect(parseOpsRunResult({ ...result, extra: 1 })).toStrictEqual(result)
    }
  })

  it('refuses unknown statuses and codes, and inconsistent confirm items', () => {
    const bad = [
      { ...ok, status: 'unsupported' },
      { ...ok, applies: 'later' },
      { ...ok, text: 'x'.repeat(OPS_LIMITS.resultBytes + 1) },
      { ...ok, data: { big: 'x'.repeat(OPS_LIMITS.callDataBytes) } },
      { ...denied, code: 'no-owner' },
      { ...denied, text: '' },
      { ...confirm, items: [] },
      { ...confirm, items: [{ ...item, labels: [] }] },
      { ...confirm, items: [{ ...item, confirmId: OTHER }] },
      { ...confirm, items: [{ ...item, hostId: 'stark' }] },
      { ...confirm, digest: 'x' },
    ]
    for (const value of bad)
      expect(parseOpsRunResult(value), JSON.stringify(value).slice(0, 80)).toBeNull()
  })

  it('reads a long op started as a job', () => {
    const started = {
      status: 'ok',
      text: 'Started package.install',
      applies: 'now',
      data: { jobId: 'j-1' },
    }
    const parsed = parseOpsRunResult(started)
    expect(parsed?.status === 'ok' && parseOpsJobData(parsed.data)).toStrictEqual({ jobId: 'j-1' })
    expect(parseOpsJobData({ jobId: 'a b' })).toBeNull()
  })
})
