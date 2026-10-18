import { describe, expect, it } from 'vitest'
import { parseClientFrame } from '../host-protocol'

const LANE = '00000000-0000-4000-8000-000000000001'
const TERM = '00000000-0000-4000-8000-000000000004'
const EPOCH = '0123456789abcdef'
const TRACE = '0011223344556677'
const FRAME = { ok: false, reason: 'frame' }
const client = (value: unknown) => parseClientFrame(JSON.stringify(value))

// Characterization through the public entry, before parseClientFrame moves to client.ts.
describe('parseClientFrame through the public entry', () => {
  it('accepts auth with only grant, challenge and trace, refusing any other key', () => {
    const auth = { type: 'auth', grant: 'g' }
    expect(client(auth)).toStrictEqual({ ok: true, frame: auth })
    for (const key of ['id', 'requestId', 'unknown', 'constructor'])
      expect(client({ ...auth, [key]: 'x' }), key).toStrictEqual(FRAME)
    expect(parseClientFrame('{"type":"auth","grant":"g","__proto__":{}}')).toStrictEqual(FRAME)
    for (const patch of [{ challenge: null }, { trace: null }, { grant: null }])
      expect(client({ ...auth, ...patch })).toStrictEqual(FRAME)
  })

  it('subscribes to all lanes or one lane, with after and trace optional', () => {
    const lanes = { type: 'subscribe', id: 'lanes', topic: 'lanes' }
    expect(client(lanes)).toStrictEqual({ ok: true, frame: lanes })
    expect(client({ ...lanes, laneId: LANE })).toStrictEqual({ ok: true, frame: lanes })
    const lane = { ...lanes, topic: 'lane', laneId: LANE, after: { epoch: EPOCH, seq: 9 } }
    expect(client({ ...lane, trace: TRACE })).toStrictEqual({
      ok: true,
      frame: { ...lane, trace: TRACE },
    })
    for (const patch of [{ laneId: undefined }, { id: 'a.b' }, { after: {} }, { trace: '' }])
      expect(client({ ...lane, ...patch })).toStrictEqual(FRAME)
    for (const topic of [undefined, 'Lane', 'terminals', 'routines'])
      expect(client({ ...lanes, topic }), String(topic)).toStrictEqual(FRAME)
  })

  it('routes the terminal topic to the exact-key terminal subscription parser', () => {
    const terminal = { type: 'subscribe', topic: 'terminal', id: 'a.b', terminalId: TERM }
    expect(client(terminal)).toStrictEqual({ ok: true, frame: terminal })
    const after = { epoch: EPOCH, seq: 0 }
    expect(client({ ...terminal, after })).toStrictEqual({
      ok: true,
      frame: { ...terminal, after },
    })
    for (const patch of [
      { trace: TRACE },
      { after: { ...after, x: 1 } },
      { terminalId: LANE + 'x' },
    ])
      expect(client({ ...terminal, ...patch })).toStrictEqual(FRAME)
  })

  it('routes terminal.input to the exact-key terminal input parser', () => {
    const input = { type: 'terminal.input', terminalId: TERM, seq: 1, data: 'é'.repeat(2048) }
    expect(client(input)).toStrictEqual({ ok: true, frame: input })
    for (const patch of [{ data: 'é'.repeat(2049) }, { seq: 0 }, { trace: TRACE }, { data: null }])
      expect(client({ ...input, ...patch })).toStrictEqual(FRAME)
  })

  it('accepts ping, unsubscribe and receipt-status by their single field', () => {
    for (const at of [0, 1, Number.MAX_SAFE_INTEGER])
      expect(client({ type: 'ping', at, x: 1 })).toStrictEqual({
        ok: true,
        frame: { type: 'ping', at },
      })
    for (const at of [-1, 1.5, '0', null, undefined])
      expect(client({ type: 'ping', at })).toStrictEqual(FRAME)
    expect(client({ type: 'unsubscribe', id: 'a_b-9', topic: 'lanes' })).toStrictEqual({
      ok: true,
      frame: { type: 'unsubscribe', id: 'a_b-9' },
    })
    expect(client({ type: 'receipt-status', requestId: LANE, laneId: LANE })).toStrictEqual({
      ok: true,
      frame: { type: 'receipt-status', requestId: LANE },
    })
  })

  it('reports invalid JSON, non-objects, oversize text and unknown types by reason', () => {
    expect(parseClientFrame('{"type":')).toStrictEqual({ ok: false, reason: 'json' })
    expect(parseClientFrame('[{"type":"ping","at":0}]')).toStrictEqual({
      ok: false,
      reason: 'object',
    })
    expect(parseClientFrame(' '.repeat(8 * 1024 * 1024 + 1))).toStrictEqual({
      ok: false,
      reason: 'frame-size',
    })
    for (const type of [undefined, null, 1, 'Ping', 'pong', 'subscribe-failed', 'terminal.ack'])
      expect(client({ type }), String(type)).toStrictEqual({ ok: false, reason: 'type' })
  })
})
