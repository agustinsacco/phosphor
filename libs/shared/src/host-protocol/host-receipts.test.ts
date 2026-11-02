import { describe, expect, it } from 'vitest'
import { HOST_LIMITS, parseHostFrame } from '../host-protocol'
import { parseReceipt, parseResultFrame } from './host-receipts'

const REQUEST = '00000000-0000-4000-8000-000000000003'
const LANE = '00000000-0000-4000-8000-000000000001'
const REFUSED = { ok: false, reason: 'host-frame' }
const host = (value: unknown) => parseHostFrame(JSON.stringify(value))
const receipt = (fields: object) =>
  host({ type: 'receipt', receipt: { requestId: REQUEST, ...fields } })
const accepted = (fields: object) => ({
  ok: true,
  value: { type: 'receipt', receipt: { requestId: REQUEST, ...fields } },
})
const REJECT_CODES = [
  'bad-request',
  'unsupported',
  'forbidden',
  'unknown-lane',
  'lane-stopped',
  'not-controller',
  'stale-fence',
  'conflict',
  'busy',
  'last-repository',
  'branch-exists',
  'too-many-requests',
]
const CALL_ERRORS = [
  'bad-request',
  'unsupported',
  'forbidden',
  'unknown-lane',
  'lane-stopped',
  'too-large',
  'internal',
]

// Characterization through the public entry, before receipt and result parsing move out.
describe('receipts and call results through the public entry', () => {
  it('accepts every receipt status, reject code and failure code', () => {
    for (const status of ['pending', 'unknown'])
      expect(receipt({ status, x: 1 })).toStrictEqual(accepted({ status }))
    for (const code of REJECT_CODES)
      expect(receipt({ status: 'rejected', code })).toStrictEqual(
        accepted({ status: 'rejected', code }),
      )
    for (const code of ['pi-error', 'timeout', 'internal']) {
      const error = { code, message: 'm' }
      expect(receipt({ status: 'failed', error: { ...error, x: 1 } })).toStrictEqual(
        accepted({ status: 'failed', error }),
      )
    }
    for (const fields of [
      { status: 'rejected', code: 'Busy' },
      { status: 'failed', error: { code: 'busy', message: 'm' } },
      { status: 'accepted' },
    ])
      expect(receipt(fields), JSON.stringify(fields)).toStrictEqual(REFUSED)
  })

  it('keeps a pending lane.create phase, and refuses one it does not know', () => {
    for (const phase of ['queued', 'branching', 'starting', 'prompting'])
      expect(receipt({ status: 'pending', phase })).toStrictEqual(
        accepted({ status: 'pending', phase }),
      )
    for (const phase of ['booting', null, 1])
      expect(receipt({ status: 'pending', phase })).toStrictEqual(REFUSED)
    expect(receipt({ status: 'unknown', phase: 'queued' })).toStrictEqual(
      accepted({ status: 'unknown' }),
    )
  })

  it('keeps done receipt data, fence and lane id only when present', () => {
    expect(receipt({ status: 'done' })).toStrictEqual(accepted({ status: 'done' }))
    const done = { status: 'done', data: { any: [1, 'x', null] }, fence: 9, laneId: LANE }
    expect(receipt(done)).toStrictEqual(accepted(done))
    for (const data of [null, 0, false, '', []])
      expect(receipt({ status: 'done', data })).toStrictEqual(accepted({ status: 'done', data }))
    for (const patch of [{ fence: 0 }, { fence: 2.5 }, { laneId: 'lane' }, { laneId: null }])
      expect(receipt({ status: 'done', ...patch })).toStrictEqual(REFUSED)
  })

  it('bounds done data by the UTF-8 bytes of its JSON', () => {
    const quotes = 2
    const ascii = 'x'.repeat(HOST_LIMITS.receiptDataBytes - quotes)
    expect(receipt({ status: 'done', data: ascii }).ok).toBe(true)
    expect(receipt({ status: 'done', data: ascii + 'x' })).toStrictEqual(REFUSED)
    const threeByte = Math.floor((HOST_LIMITS.receiptDataBytes - quotes) / 3)
    const wide =
      '中'.repeat(threeByte) + 'x'.repeat(HOST_LIMITS.receiptDataBytes - quotes - 3 * threeByte)
    expect(receipt({ status: 'done', data: wide }).ok).toBe(true)
    expect(receipt({ status: 'done', data: wide + 'x' })).toStrictEqual(REFUSED)
    expect(receipt({ status: 'done', data: { k: '\ud800'.repeat(10) } }).ok).toBe(true)
  })

  it('refuses data nested deeper than the serializer can walk, without throwing', () => {
    for (const depth of [10, 100_000]) {
      const data = '['.repeat(depth) + ']'.repeat(depth)
      const text = `{"type":"receipt","receipt":{"requestId":"${REQUEST}","status":"done","data":${data}}}`
      expect(parseHostFrame(text).ok).toBe(depth === 10)
    }
  })

  it('checks rejected control and failed messages, and every call result code', () => {
    const control = { fence: 2, controller: null }
    expect(receipt({ status: 'rejected', code: 'stale-fence', control })).toStrictEqual(
      accepted({ status: 'rejected', code: 'stale-fence', control }),
    )
    expect(receipt({ status: 'rejected', code: 'busy', control: null })).toStrictEqual(REFUSED)
    for (const message of ['', 'm'.repeat(2001), 1])
      expect(receipt({ status: 'failed', error: { code: 'timeout', message } })).toStrictEqual(
        REFUSED,
      )
    for (const code of CALL_ERRORS) {
      const error = { code, message: 'x'.repeat(2000) }
      expect(host({ type: 'result', id: 'c', ok: false, error: { ...error, x: 1 } })).toStrictEqual(
        {
          ok: true,
          value: { type: 'result', id: 'c', ok: false, error },
        },
      )
    }
    expect(
      host({ type: 'result', id: 'c', ok: false, error: { code: 'timeout', message: 'm' } }),
    ).toStrictEqual(REFUSED)
    expect(host({ type: 'result', id: 'c', ok: false, data: 1 })).toStrictEqual(REFUSED)
  })
})

describe('host-receipts.ts', () => {
  it('parses every receipt status from a record', () => {
    for (const status of ['pending', 'unknown'])
      expect(parseReceipt({ requestId: REQUEST, status })).toStrictEqual({
        requestId: REQUEST,
        status,
      })
    const done = { requestId: REQUEST, status: 'done', data: { a: 1 }, fence: 1, laneId: LANE }
    expect(parseReceipt(done)).toStrictEqual(done)
    for (const code of REJECT_CODES)
      expect(parseReceipt({ requestId: REQUEST, status: 'rejected', code })).toStrictEqual({
        requestId: REQUEST,
        status: 'rejected',
        code,
      })
    expect(
      parseReceipt({
        requestId: REQUEST,
        status: 'failed',
        error: { code: 'internal', message: 'm' },
      }),
    ).toStrictEqual({
      requestId: REQUEST,
      status: 'failed',
      error: { code: 'internal', message: 'm' },
    })
  })

  it('returns null rather than throwing for data it cannot serialize', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    let nested: unknown = 0
    for (let i = 0; i < 100_000; i++) nested = [nested]
    for (const data of [cyclic, nested, 1n])
      expect(parseReceipt({ requestId: REQUEST, status: 'done', data })).toBeNull()
    const exact = 'x'.repeat(HOST_LIMITS.receiptDataBytes - 2)
    expect(parseReceipt({ requestId: REQUEST, status: 'done', data: exact })).toStrictEqual({
      requestId: REQUEST,
      status: 'done',
      data: exact,
    })
    expect(parseReceipt({ requestId: REQUEST, status: 'done', data: exact + 'x' })).toBeNull()
  })

  it('parses ok results without looking at their data, and error results by code', () => {
    const ok = { type: 'result', id: 'c', ok: true, data: undefined }
    expect(parseResultFrame(ok)).toStrictEqual(ok)
    expect(parseResultFrame({ type: 'result', id: 'c', ok: true })).toBeNull()
    for (const code of CALL_ERRORS) {
      const error = { type: 'result', id: 'c', ok: false, error: { code, message: 'm' } }
      expect(parseResultFrame(error)).toStrictEqual(error)
    }
    expect(
      parseResultFrame({
        type: 'result',
        id: 'c',
        ok: false,
        error: { code: 'busy', message: 'm' },
      }),
    ).toBeNull()
  })
})
