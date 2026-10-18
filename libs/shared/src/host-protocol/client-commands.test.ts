import { describe, expect, it } from 'vitest'
import { parseClientFrame } from '../host-protocol'
import { parseCallFrame, parseCommandFrame } from './client-commands'

const LANE = '00000000-0000-4000-8000-000000000001'
const REQUEST = '00000000-0000-4000-8000-000000000003'
const OTHER = '00000000-0000-4000-8000-0000000000ff'
const TRACE = '0011223344556677'
const FRAME = { ok: false, reason: 'frame' }
const client = (value: unknown) => parseClientFrame(JSON.stringify(value))
const command = (fields: object) => client({ type: 'command', requestId: REQUEST, ...fields })
const receipt = (code: string, requestId = REQUEST) => ({
  ok: false,
  reason: 'command',
  reply: { kind: 'receipt', requestId, code },
})
const call = (fields: object) => client({ type: 'call', id: 'call', ...fields })
const CALL_REPLY = {
  ok: false,
  reason: 'call',
  reply: { kind: 'result', id: 'call', code: 'bad-request' },
}

// Characterization through the public entry, before command and call checks move out.
describe('command and call frames through the public entry', () => {
  it('refuses an invalid request id bare, before looking at the op', () => {
    for (const requestId of [undefined, null, 1, '', 'bad', REQUEST.replace('4000', '4ABC')])
      for (const op of [{ type: 'abort' }, { type: 'bash' }, null])
        expect(client({ type: 'command', requestId, op })).toStrictEqual(FRAME)
  })

  it('replies to a refused command with its own request id', () => {
    const frame = { type: 'command', requestId: OTHER }
    expect(client({ ...frame, op: { type: 'bash' } })).toStrictEqual(receipt('unsupported', OTHER))
    expect(client({ ...frame, op: { type: 'abort' }, fence: 0 })).toStrictEqual(
      receipt('bad-request', OTHER),
    )
  })

  it('keeps lane id, fence and trace only when present and within bounds', () => {
    const op = { type: 'abort' }
    expect(command({ op })).toStrictEqual({
      ok: true,
      frame: { type: 'command', requestId: REQUEST, op },
    })
    const fields = { laneId: LANE, fence: Number.MAX_SAFE_INTEGER, trace: TRACE }
    expect(command({ op, ...fields, secret: 1 })).toStrictEqual({
      ok: true,
      frame: { type: 'command', requestId: REQUEST, op, ...fields },
    })
    for (const patch of [{ fence: 0 }, { fence: -1 }, { fence: '1' }, { laneId: '' }, { trace: 1 }])
      expect(command({ op, ...patch })).toStrictEqual(receipt('bad-request'))
  })

  it('refuses a lane id or fence on laneless families even when the op is valid', () => {
    for (const op of [
      { type: 'routine.pauseAll' },
      { type: 'provider.login', provider: 'p' },
      { type: 'host.repositories.add', path: 'p' },
    ])
      for (const patch of [{ laneId: LANE }, { fence: 1 }])
        expect(command({ op, ...patch }), op.type).toStrictEqual(receipt('bad-request'))
    for (const op of [
      { type: 'terminal.create', cols: 80, rows: 24 },
      { type: 'files.delete', path: 'a' },
    ])
      expect(command({ op, laneId: LANE, fence: 1 }).ok, op.type).toBe(true)
  })

  it('checks a call id before its method, and the method before its trace', () => {
    expect(client({ type: 'call', id: 'a.b', method: 'Bad' })).toStrictEqual(FRAME)
    expect(call({ method: 'Bad', trace: 'bad' })).toStrictEqual(CALL_REPLY)
    expect(call({ id: 'other', method: 'a.b', trace: 'bad' })).toStrictEqual({
      ...CALL_REPLY,
      reply: { ...CALL_REPLY.reply, id: 'other' },
    })
    for (const method of ['a.b', 'a.b.c', 'a1.bB2', 'lane.' + 'x'.repeat(59)])
      expect(call({ method }).ok, method).toBe(true)
    for (const method of ['a', 'a.b.c.d', 'A.b', 'a.B', 'a_b.c', 'a-b.c', 'a.', '.a', 'a..b', 1])
      expect(call({ method }), String(method)).toStrictEqual(CALL_REPLY)
  })

  it('passes any params value through untouched and omits absent params', () => {
    expect(call({ method: 'a.b' })).toStrictEqual({
      ok: true,
      frame: { type: 'call', id: 'call', method: 'a.b' },
    })
    for (const params of [null, 0, false, '', [], {}, [{ deep: { list: [1] } }]])
      expect(call({ method: 'a.b', params, secret: 1 })).toStrictEqual({
        ok: true,
        frame: { type: 'call', id: 'call', method: 'a.b', params },
      })
  })
})

describe('client-commands.ts', () => {
  const frame = (fields: object) => ({ type: 'command', requestId: REQUEST, ...fields })

  it('refuses a command with no usable request id bare, otherwise with a receipt reply', () => {
    expect(parseCommandFrame({ type: 'command', op: { type: 'abort' } })).toStrictEqual(FRAME)
    expect(parseCommandFrame(frame({ op: { type: 'files.write' } }))).toStrictEqual(
      receipt('unsupported'),
    )
    expect(parseCommandFrame(frame({ op: { type: 'routine.save' } }))).toStrictEqual(
      receipt('bad-request'),
    )
    expect(parseCommandFrame(frame({ op: ['abort'] }))).toStrictEqual(receipt('bad-request'))
  })

  it('applies lane and fence rules after the op parses', () => {
    const op = { type: 'routine.run', routineId: OTHER }
    expect(parseCommandFrame(frame({ op }))).toStrictEqual({ ok: true, frame: frame({ op }) })
    expect(parseCommandFrame(frame({ op, fence: 2 }))).toStrictEqual(receipt('bad-request'))
    const fenced = frame({ op: { type: 'abort' }, laneId: LANE, fence: 2, trace: TRACE })
    expect(parseCommandFrame({ ...fenced, extra: true })).toStrictEqual({ ok: true, frame: fenced })
  })

  it('validates a call by id, method grammar and trace', () => {
    const base = { type: 'call', id: 'c', method: 'lane.state' }
    expect(parseCallFrame(base)).toStrictEqual({ ok: true, frame: base })
    expect(parseCallFrame({ ...base, id: undefined })).toStrictEqual(FRAME)
    const reply = {
      ok: false,
      reason: 'call',
      reply: { kind: 'result', id: 'c', code: 'bad-request' },
    }
    for (const patch of [{ method: 'm'.repeat(65) }, { method: 'lane' }, { trace: 'x' }])
      expect(parseCallFrame({ ...base, ...patch })).toStrictEqual(reply)
  })
})
