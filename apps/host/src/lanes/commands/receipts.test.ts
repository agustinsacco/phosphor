import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { HOST_LIMITS, type Receipt } from '@phosphor/shared/host-protocol'
import {
  controlFailure,
  deliver,
  durableReceipt,
  log,
  receiptMessage,
  rejected,
  terminal,
  type ReceiptPorts,
} from './receipts'
import type { Job, LaneCommandFrame, Terminal } from './state'

function job(frame: Partial<LaneCommandFrame> = {}): Job {
  return {
    client: { id: randomUUID(), label: 'One', caps: ['sessions.control'], connectionId: 'conn' },
    frame: {
      type: 'command',
      requestId: randomUUID(),
      laneId: randomUUID(),
      fence: 1,
      op: { type: 'abort' },
      ...frame,
    },
    started: 100,
    resolve: vi.fn(),
  }
}
function ports() {
  return {
    store: { finishRequest: vi.fn<(requestId: string, receipt: Receipt) => void>() },
    deliver: vi.fn<ReceiptPorts['deliver']>(),
    log: vi.fn<ReceiptPorts['log']>(),
    now: vi.fn(() => 150),
  } satisfies ReceiptPorts
}
const open = { closed: false }
const big = 'x'.repeat(HOST_LIMITS.receiptDataBytes + 1)

describe('durableReceipt', () => {
  it('keeps receipts without data or within the cap, and drops only oversized done data', () => {
    const done: Terminal = { requestId: randomUUID(), status: 'done', fence: 2, data: { ok: 1 } }
    expect(durableReceipt(done)).toBe(done)
    const bare: Terminal = { requestId: randomUUID(), status: 'done' }
    expect(durableReceipt(bare)).toBe(bare)
    const unknown: Terminal = { requestId: randomUUID(), status: 'unknown' }
    expect(durableReceipt(unknown)).toBe(unknown)
    const oversized: Terminal = { requestId: done.requestId, status: 'done', fence: 3, data: big }
    expect(durableReceipt(oversized)).toEqual({
      requestId: done.requestId,
      status: 'done',
      fence: 3,
    })
  })

  it('rethrows the validation error for invalid runtime data instead of storing it', () => {
    const data = {
      get text(): string {
        throw new Error('invalid runtime data')
      },
    }
    expect(() => durableReceipt({ requestId: randomUUID(), status: 'done', data })).toThrow(
      'Invalid Host state input.',
    )
  })
})

describe('terminal', () => {
  it('records, delivers client-wide and logs identity, status, fence and elapsed time', () => {
    const p = ports()
    const current = job({ trace: 'trace-1' })
    const receipt: Terminal = { requestId: current.frame.requestId, status: 'done', fence: 4 }
    terminal(open, p, current, receipt, true)
    expect(p.store.finishRequest).toHaveBeenCalledWith(current.frame.requestId, receipt)
    expect(p.deliver).toHaveBeenCalledWith(current.client.id, receipt, undefined)
    expect(p.log).toHaveBeenCalledWith('host', 'lane.command', {
      laneId: current.frame.laneId,
      requestId: current.frame.requestId,
      op: 'abort',
      status: 'done',
      code: undefined,
      fence: 4,
      ms: 50,
      trace: 'trace-1',
      reason: undefined,
    })
  })

  it('delivers an unrecorded refusal only to the attempt connection, without a store write', () => {
    const p = ports()
    const current = job()
    rejected(open, p, current, 'busy', false)
    expect(p.store.finishRequest).not.toHaveBeenCalled()
    expect(p.deliver).toHaveBeenCalledWith(
      current.client.id,
      { requestId: current.frame.requestId, status: 'rejected', code: 'busy' },
      'conn',
    )
    expect(p.log.mock.calls[0]?.[2]).toMatchObject({ status: 'rejected', code: 'busy' })
  })

  it('stores and delivers unknown for invalid runtime data, and the capped receipt for oversized data', () => {
    const p = ports()
    const current = job()
    const data = {
      get text(): string {
        throw new Error('invalid runtime data')
      },
    }
    terminal(open, p, current, { requestId: current.frame.requestId, status: 'done', data }, true)
    const unknown = { requestId: current.frame.requestId, status: 'unknown' }
    expect(p.store.finishRequest).toHaveBeenLastCalledWith(current.frame.requestId, unknown)
    expect(p.deliver).toHaveBeenLastCalledWith(current.client.id, unknown, undefined)
    terminal(
      open,
      p,
      current,
      { requestId: current.frame.requestId, status: 'done', data: big },
      true,
    )
    expect(p.deliver).toHaveBeenLastCalledWith(
      current.client.id,
      { requestId: current.frame.requestId, status: 'done' },
      undefined,
    )
    expect(JSON.stringify(p.log.mock.calls)).not.toContain('xxxx')
  })

  it('logs codes and rejected control fences, and the reason it was given', () => {
    const p = ports()
    const current = job()
    const requestId = current.frame.requestId
    controlFailure(open, p, current)
    expect(p.store.finishRequest).toHaveBeenCalledWith(requestId, {
      requestId,
      status: 'failed',
      error: { code: 'internal', message: "the lane's control change could not be published" },
    })
    const control = { fence: 7, controller: null }
    terminal(
      open,
      p,
      current,
      { requestId, status: 'rejected', code: 'stale-fence', control },
      true,
    )
    terminal(open, p, current, { requestId, status: 'unknown' }, true, 'deadline')
    expect(p.log.mock.calls.map((call) => call[2])).toEqual([
      expect.objectContaining({ status: 'failed', code: 'internal', fence: undefined }),
      expect.objectContaining({ status: 'rejected', code: 'stale-fence', fence: 7 }),
      expect.objectContaining({ status: 'unknown', code: undefined, reason: 'deadline' }),
    ])
  })

  it('still delivers when recording, delivery, logging or the clock fail', () => {
    const p = ports()
    const current = job()
    p.store.finishRequest.mockImplementation(() => {
      throw new Error('private storage failure')
    })
    p.now.mockImplementation(() => {
      throw new Error('clock failed')
    })
    terminal(open, p, current, { requestId: current.frame.requestId, status: 'unknown' }, true)
    expect(p.log.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      [
        'lane.receipt_unrecorded',
        { laneId: current.frame.laneId, requestId: current.frame.requestId },
      ],
      ['lane.command', expect.objectContaining({ status: 'unknown', ms: undefined })],
    ])
    expect(p.deliver).toHaveBeenCalledTimes(1)
    p.deliver.mockImplementation(() => {
      throw new Error('disconnected')
    })
    p.log.mockImplementation(() => {
      throw new Error('logger unavailable')
    })
    expect(() =>
      terminal(open, p, current, { requestId: current.frame.requestId, status: 'unknown' }, true),
    ).not.toThrow()
    expect(JSON.stringify(p.log.mock.calls)).not.toContain('private storage failure')
  })

  it('clamps a clock that moved backwards and does nothing once closed', () => {
    const p = ports()
    const current = job()
    p.now.mockReturnValue(10)
    terminal(open, p, current, { requestId: current.frame.requestId, status: 'unknown' }, true)
    expect(p.log.mock.calls[0]?.[2]).toMatchObject({ ms: 0 })
    terminal(
      { closed: true },
      p,
      current,
      { requestId: current.frame.requestId, status: 'unknown' },
      true,
    )
    expect(p.store.finishRequest).toHaveBeenCalledTimes(1)
    expect(p.deliver).toHaveBeenCalledTimes(1)
    expect(p.log).toHaveBeenCalledTimes(1)
  })
})

describe('deliver and log', () => {
  it('pass connection ids through and swallow port failures', () => {
    const p = ports()
    const receipt: Receipt = { requestId: randomUUID(), status: 'pending' }
    deliver(p, 'client', receipt, 'conn-2')
    expect(p.deliver).toHaveBeenCalledWith('client', receipt, 'conn-2')
    log(p, 'lane.publish_failed', { kind: 'control' })
    expect(p.log).toHaveBeenCalledWith('host', 'lane.publish_failed', { kind: 'control' })
    p.deliver.mockImplementation(() => {
      throw new Error('disconnected')
    })
    p.log.mockImplementation(() => {
      throw new Error('logger unavailable')
    })
    expect(() => deliver(p, 'client', receipt)).not.toThrow()
    expect(() => log(p, 'message', null)).not.toThrow()
  })
})

describe('receiptMessage', () => {
  it('replaces control and separator characters, trims, and falls back when empty', () => {
    expect(receiptMessage(`  a${String.fromCharCode(0)}b\nc\u2028d\u2029e${'\x7f'}  `)).toBe(
      'a b c d e',
    )
    expect(receiptMessage(String.fromCharCode(9, 10, 127))).toBe('pi reported an error')
    for (const raw of [null, undefined, 1, {}])
      expect(receiptMessage(raw)).toBe('pi reported an error')
  })

  it('caps at the message limit without splitting a surrogate pair', () => {
    expect(receiptMessage('x'.repeat(HOST_LIMITS.messageChars + 5))).toHaveLength(
      HOST_LIMITS.messageChars,
    )
    const emoji = 'x'.repeat(HOST_LIMITS.messageChars - 1) + '😀'
    expect(receiptMessage(emoji)).toBe('x'.repeat(HOST_LIMITS.messageChars - 1))
  })
})
