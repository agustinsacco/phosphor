import { afterEach, expect, it, vi } from 'vitest'
import { OP_CHANNEL_LIMITS, OP_TITLE, parseOpChannelRequest } from '@phosphor/shared/ops'
import { OPS_LIMITS } from '@phosphor/shared/host-protocol-ops'
import { LANE_OP_LIMITS, sendOp } from './op-channel'

const request = { op: 'brain.search', args: { query: 'release' } }
afterEach(() => vi.useRealTimers())

it('sends a structured request readable by the owner, with no shell or catalog dependency', async () => {
  const ctx = {
    ui: {
      editor: async (title: string, prefill: string) => {
        expect(title).toBe(OP_TITLE)
        const envelope = parseOpChannelRequest(prefill)
        expect(envelope).toMatchObject({
          v: 1,
          op: request.op,
          input: request.args,
          deadlineMs: 30_000,
        })
        return JSON.stringify({
          v: 1,
          id: envelope!.id,
          status: 'ok',
          text: 'ok',
          data: { hits: [] },
          applies: 'now',
        })
      },
    },
  }
  expect(await sendOp(ctx, request)).toMatchObject({ status: 'ok', data: { hits: [] } })
})

it('answers no-owner when no UI is bound, or the editor returns no value', async () => {
  for (const ctx of [{}, { ui: { editor: async () => undefined } }]) {
    expect(await sendOp(ctx, request)).toMatchObject({ status: 'unsupported', code: 'no-owner' })
  }
})

it.each([
  '{}',
  'not json',
  JSON.stringify({ v: 1, id: 'other', status: 'ok', text: 'wrong lane', applies: 'now' }),
])('rejects a malformed or uncorrelated reply', async (raw) => {
  expect(await sendOp({ ui: { editor: async () => raw } }, request)).toMatchObject({
    status: 'error',
    code: 'bad-request',
  })
})

it.each(['abort', 'deadline'])(
  'abandons the editor on %s, even if the owner answers later',
  async (which) => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let reject!: (reason: Error) => void
    const ui = {
      editor: vi.fn(
        () =>
          new Promise<string>((_, no) => {
            reject = no
          }),
      ),
    }
    const pending = sendOp({ ui }, request, { signal: controller.signal, deadlineMs: 10 })
    if (which === 'abort') controller.abort()
    else await vi.advanceTimersByTimeAsync(2010)
    expect(await pending).toMatchObject({
      status: 'error',
      code: which === 'abort' ? 'aborted' : 'timeout',
    })
    expect(vi.getTimerCount()).toBe(0)
    reject(new Error('late response'))
    await Promise.resolve()
  },
)

it('never starts a request for an already stopped turn', async () => {
  const ui = { editor: vi.fn() }
  expect(await sendOp({ ui }, request, { signal: AbortSignal.abort() })).toMatchObject({
    code: 'aborted',
  })
  expect(ui.editor).not.toHaveBeenCalled()
})

it('mirrors the owner limits it cannot import at runtime', () => {
  expect(LANE_OP_LIMITS).toEqual({
    ARGS_BYTES: OPS_LIMITS.argsBytes,
    CONTENT_BYTES: OPS_LIMITS.contentBytes,
    PREFILL_BYTES: OP_CHANNEL_LIMITS.prefillBytes,
  })
})
