import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOST_LIMITS, parseHostFrame, type LanePiOp } from '@phosphor/shared/host-protocol'
import { openStore, opHash } from './store'
import { createLaneCommands, receiptMessage } from './commands'
import {
  createCommandsFixture,
  deferred,
  type CommandsFixture,
} from './__fixtures__/commands.fixture'

let f: CommandsFixture
beforeEach(async () => {
  vi.useFakeTimers()
  f = await createCommandsFixture()
})
afterEach(() => {
  f.cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('lane command guards and operations', () => {
  it('caps pi errors, drops oversize data in delivered receipts and logs no content', async () => {
    const request = { ...f.frame(), trace: '1234567890abcdef' }
    const a = f.service.submit(f.one, request)
    f.finish(0, {
      type: 'response',
      command: 'prompt',
      success: false,
      error: 'private error'.repeat(HOST_LIMITS.messageChars),
    })
    await a
    expect(f.last(request.requestId)).toMatchObject({
      status: 'failed',
      error: { code: 'pi-error', message: expect.any(String) },
    })
    const receipt = f.last(request.requestId)
    if (receipt?.status !== 'failed') throw new Error('missing failure')
    expect(receipt.error.message).toHaveLength(HOST_LIMITS.messageChars)
    const huge = f.frame({ type: 'abort' }, 2)
    const b = f.service.submit(f.one, huge)
    f.finish(1, { ...f.success, data: { text: 'x'.repeat(HOST_LIMITS.receiptDataBytes) } })
    await b
    expect(f.last(huge.requestId)).toEqual({ requestId: huge.requestId, status: 'done', fence: 2 })
    expect(f.last(huge.requestId)).toEqual(f.store.getReceipt(huge.requestId, f.one.id))
    expect(JSON.stringify(f.logs)).not.toMatch(/private prompt|private error/)
    expect(f.logs[0]?.data).toMatchObject({
      trace: request.trace,
      status: 'failed',
      code: 'pi-error',
    })
  })

  it('normalizes pi error text into a stored, wire-valid failure', async () => {
    const request = f.frame()
    const running = f.service.submit(f.one, request)
    f.finish(0, {
      type: 'response',
      command: 'prompt',
      success: false,
      error: 'line one\nline two',
    })
    await running
    const receipt = f.last(request.requestId)
    expect(receipt).toMatchObject({
      status: 'failed',
      error: { code: 'pi-error', message: 'line one line two' },
    })
    expect(f.store.getReceipt(request.requestId, f.one.id)).toEqual(receipt)
    f.service.status(f.one.id, request.requestId)
    expect(f.last(request.requestId)).toEqual(receipt)
    expect(parseHostFrame(JSON.stringify({ type: 'receipt', receipt })).ok).toBe(true)
  })

  it.each([HOST_LIMITS.messageChars, HOST_LIMITS.messageChars + 1])(
    'keeps pi error messages bounded at %i characters',
    async (length) => {
      const request = f.frame()
      const running = f.service.submit(f.one, request)
      f.finish(0, {
        type: 'response',
        command: 'prompt',
        success: false,
        error: 'x'.repeat(length),
      })
      await running
      expect(f.last(request.requestId)).toMatchObject({
        status: 'failed',
        error: { message: 'x'.repeat(HOST_LIMITS.messageChars) },
      })
    },
  )

  it.each([
    { type: 'prompt', message: 'x' },
    { type: 'steer', message: 'x' },
    { type: 'follow_up', message: 'x' },
    { type: 'abort' },
    { type: 'abort_retry' },
    { type: 'set_model', provider: 'p', modelId: 'm' },
    { type: 'set_thinking_level', level: 'off' },
    { type: 'compact', customInstructions: 'x' },
    { type: 'set_session_name', name: 'x' },
  ] satisfies LanePiOp[])(
    'forwards $type fields with a Host correlation id and no summary',
    async (op) => {
      const request = f.frame(op)
      const running = f.service.submit(f.one, request)
      expect(f.command).toHaveBeenCalledWith('pi-live', { ...op, id: request.requestId })
      f.finish(0)
      await running
      expect(f.events.map((e) => e.event.kind)).toEqual(['control'])
    },
  )

  it('maps store started-row capacity to unrecorded busy', async () => {
    f.store.close()
    f.store = await openStore(join(f.root, 'state'), process.getuid?.(), {
      limits: { receiptsKept: 1 },
    })
    f.service = createLaneCommands({ ...f.ports, store: f.store })
    const candidates = [f.frame({ type: 'control.take' }), f.frame({ type: 'control.take' })].sort(
      (a, b) => a.requestId.localeCompare(b.requestId),
    )
    const request = candidates[0]
    const older = candidates[1]
    if (!request || !older) throw new Error('missing tie ids')
    const outstanding = older.requestId
    f.store.beginRequest(outstanding, f.one.id, opHash({ type: 'abort' }), f.lane.laneId)
    await f.service.submit(f.one, request)
    expect(f.last(request.requestId)).toMatchObject({ code: 'busy' })
    expect(f.store.getReceipt(request.requestId, f.one.id)).toBeNull()
    f.store.finishRequest(outstanding, { requestId: outstanding, status: 'unknown' })
    await f.service.submit(f.one, request)
    expect(f.last(request.requestId)?.status).toBe('done')
    expect(f.store.getReceipt(request.requestId, f.one.id)).toBeNull()
  })

  it('delivers a settled pi receipt even when every finishRequest throws', async () => {
    const finishRequest = vi.spyOn(f.store, 'finishRequest').mockImplementation(() => {
      throw new Error('private storage failure')
    })
    try {
      const request = f.frame()
      const running = f.service.submit(f.one, request)
      f.finish(0)
      await running
      expect(f.last(request.requestId)).toEqual({
        requestId: request.requestId,
        status: 'done',
        fence: 2,
      })
      expect(f.logs).toContainEqual({
        message: 'lane.receipt_unrecorded',
        data: { laneId: f.lane.laneId, requestId: request.requestId },
      })
      f.service.status(f.one.id, request.requestId)
      expect(f.last(request.requestId)?.status).toBe('pending')
      f.store.markInterrupted()
      f.service.status(f.one.id, request.requestId)
      expect(f.last(request.requestId)?.status).toBe('unknown')
      expect(JSON.stringify(f.logs)).not.toContain('private storage failure')
      await vi.advanceTimersByTimeAsync(0)
    } finally {
      finishRequest.mockRestore()
    }
  })

  it('delivers unknown for invalid runtime data without throwing or leaving the submission unresolved', async () => {
    const request = f.frame()
    const running = f.service.submit(f.one, request)
    f.finish(0, {
      ...f.success,
      data: {
        get text(): string {
          throw new Error('invalid runtime data')
        },
      },
    })
    await running
    expect(f.last(request.requestId)).toEqual({ requestId: request.requestId, status: 'unknown' })
    expect(f.store.getReceipt(request.requestId, f.one.id)).toEqual(f.last(request.requestId))
    expect(f.logs).toContainEqual({
      message: 'lane.command',
      data: expect.objectContaining({ status: 'unknown' }),
    })
  })

  it('resolves synchronous control.take and drains the next queued job when every finishRequest throws', async () => {
    const deletion = vi.spyOn(Map.prototype, 'delete')
    const finishRequest = vi.spyOn(f.store, 'finishRequest').mockImplementation(() => {
      throw new Error('storage failed')
    })
    f.sessions.clear()
    const response = deferred<void>()
    f.ports.resumeLane = () => response.promise
    try {
      const running = f.service.submit(f.one, f.frame({ type: 'lane.resume' }))
      const take = f.frame({ type: 'control.take' })
      let takeResolved = false
      const taken = f.service.submit(f.one, take).then(() => {
        takeResolved = true
      })
      const read = f.frame({ type: 'lane.markRead', upTo: 0 })
      let readResolved = false
      const next = f.service.submit(f.one, read).then(() => {
        readResolved = true
      })
      expect(f.last(take.requestId)).toBeUndefined()
      response.release()
      await vi.advanceTimersByTimeAsync(0)
      expect(takeResolved).toBe(true)
      expect(readResolved).toBe(true)
      expect(f.last(take.requestId)).toMatchObject({ status: 'done', fence: 3 })
      expect(f.last(read.requestId)?.status).toBe('done')
      expect(deletion.mock.calls.filter(([key]) => key === f.lane.laneId)).toHaveLength(1)
      await Promise.all([running, taken, next])
    } finally {
      finishRequest.mockRestore()
      deletion.mockRestore()
    }
  })

  it('delivers and drains when the terminal clock throws', async () => {
    const take = f.frame({ type: 'control.take' })
    f.ports.now = vi
      .fn(() => Date.now())
      .mockReturnValueOnce(Date.now())
      .mockImplementationOnce(() => {
        throw new Error('clock failed')
      })
    await f.service.submit(f.one, take)
    expect(f.receipts(take.requestId)).toEqual([
      { requestId: take.requestId, status: 'done', fence: 2 },
    ])
    expect(
      f.logs.filter((entry) => entry.message === 'lane.command').map((entry) => entry.data),
    ).toEqual([expect.objectContaining({ ms: undefined })])
    const request = f.frame({ type: 'abort' }, 2)
    const next = f.service.submit(f.one, request)
    expect(f.command).toHaveBeenCalledTimes(1)
    f.finish(0)
    await next
    expect(f.last(request.requestId)?.status).toBe('done')
  })

  it('delivery and logging failures do not strand the lane queue', async () => {
    f.ports.deliver = () => {
      throw new Error('disconnected')
    }
    f.ports.log = () => {
      throw new Error('logger unavailable')
    }
    const first = f.frame()
    const a = f.service.submit(f.one, first)
    const b = f.service.submit(f.one, f.frame({ type: 'abort' }, 2))
    f.finish(0)
    await a
    expect(f.store.getReceipt(first.requestId, f.one.id)?.status).toBe('done')
    expect(f.command).toHaveBeenCalledTimes(2)
    f.finish(1)
    await b
  })
})

describe('receiptMessage matches store and wire limits', () => {
  it('replaces rejected text characters with spaces and trims the ends', () => {
    const controls = [10, 9, 0, 127, 0x2028, 0x2029]
    expect(
      receiptMessage(
        '  ' + controls.map((code) => `a${String.fromCharCode(code)}b`).join('') + '  ',
      ),
    ).toBe('a ba ba ba ba ba b')
  })
  it.each(['', String.fromCharCode(0, 9, 10, 127, 0x2028, 0x2029)])(
    'uses a wire-valid fixed sentence for empty normalized text',
    (raw) => {
      const message = receiptMessage(raw)
      expect(message).toBe('pi reported an error')
      expect(
        parseHostFrame(
          JSON.stringify({
            type: 'receipt',
            receipt: {
              requestId: randomUUID(),
              status: 'failed',
              error: { code: 'pi-error', message },
            },
          }),
        ).ok,
      ).toBe(true)
    },
  )
  it('does not split a surrogate pair at the UTF-16 limit', () => {
    expect(receiptMessage('x'.repeat(HOST_LIMITS.messageChars - 1) + '🙂')).toBe(
      'x'.repeat(HOST_LIMITS.messageChars - 1),
    )
  })
  it.each([null, undefined, 123, {}])('uses fixed text for non-string input', (raw) => {
    expect(receiptMessage(raw)).toBe('pi reported an error')
  })
})
