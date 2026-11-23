import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionUIRequest, ExtensionUIResponse } from '@shared/rpc'
import { JsonlDecoder } from './jsonl'
import {
  OP_BACKSTOP_GRACE_MS,
  OpChannel,
  opChildEnv,
  opMarkerSet,
  type OpChannelPorts,
  type OpChannelRequestEvent,
} from './op-channel'

afterEach(() => vi.useRealTimers())

function channel(marked = true, overrides: Partial<OpChannelPorts> = {}) {
  const written: ExtensionUIResponse[] = []
  const requests: OpChannelRequestEvent[] = []
  const ports: OpChannelPorts = {
    write: (response) => written.push(response),
    log: vi.fn(),
    listening: () => true,
    emitRequest: (event) => requests.push(event),
    emitLiveness: vi.fn(),
    emitStop: vi.fn(),
    ...overrides,
  }
  return { ops: new OpChannel(marked, ports), written, requests, ports }
}
const editor = (prefill: string, title = 'phosphor-op/v1'): ExtensionUIRequest => ({
  type: 'extension_ui_request',
  id: 'editor-1',
  method: 'editor',
  title,
  prefill,
})
const envelope = JSON.stringify({ v: 1, id: 'op-1', argv: ['help'], deadlineMs: 1_000 })
const reply = (response: ExtensionUIResponse) =>
  JSON.parse((response as { value: string }).value) as Record<string, unknown>

describe('OpChannel', () => {
  it('reads the marker from the spawn env only', () => {
    expect(opMarkerSet({ PHOSPHOR_OPS: 'v1' })).toBe(true)
    expect(opMarkerSet({ PHOSPHOR_OPS: 'v2' })).toBe(false)
    expect(opMarkerSet(undefined)).toBe(false)
  })

  it('builds the child env without an inherited marker', () => {
    vi.stubEnv('PHOSPHOR_OPS', 'v1')
    try {
      expect(opChildEnv({ A: '1' }, true)).not.toHaveProperty('PHOSPHOR_OPS')
      expect(opChildEnv({ A: '1' }, true).PATH).toBe(process.env.PATH)
      expect(opChildEnv({ A: '1', PHOSPHOR_OPS: 'v1' }, true).PHOSPHOR_OPS).toBe('v1')
      expect(opChildEnv({ A: '1' }, false)).toEqual({ A: '1' })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('never hands a lane Brain credentials or Brain test hooks, inherited or passed', () => {
    const keys = [
      'PHOSPHOR_BRAIN_ENDPOINT',
      'PHOSPHOR_BRAIN_TOKEN',
      'PHOSPHOR_BRAIN_EMBEDDING_MODEL_DIR',
      'PHOSPHOR_BRAIN_TEST_EMBEDDINGS',
    ]
    for (const key of keys) vi.stubEnv(key, 'parent')
    try {
      const own = Object.fromEntries(keys.map((key) => [key, 'own']))
      for (const env of [opChildEnv({ A: '1' }, true), opChildEnv({ A: '1', ...own }, false)]) {
        for (const key of keys) expect(env).not.toHaveProperty(key)
        expect(env.A).toBe('1')
      }
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('consumes only the reserved editor title in a marker session', () => {
    const { ops } = channel()
    expect(ops.consume(editor(envelope, 'Edit notes'))).toBe(false)
    expect(
      ops.consume({
        type: 'extension_ui_request',
        id: 'x',
        method: 'input',
        title: 'phosphor-op/v1',
      }),
    ).toBe(false)
    expect(channel(false).ops.consume(editor(envelope))).toBe(false)
    expect(ops.consume(editor(envelope))).toBe(true)
  })

  it('answers timeout from the backstop when the owner never responds', () => {
    vi.useFakeTimers()
    const { ops, written, requests } = channel()
    ops.consume(editor(envelope))
    vi.advanceTimersByTime(1_000 + OP_BACKSTOP_GRACE_MS - 1)
    expect(written).toEqual([])
    vi.advanceTimersByTime(1)
    expect(reply(written[0]!)).toMatchObject({ id: 'op-1', status: 'error', code: 'timeout' })
    requests[0]!.respond({ v: 1, id: 'op-1', status: 'ok', text: 'late', applies: 'now' })
    expect(written).toHaveLength(1)
    expect(ops.pendingCount).toBe(0)
  })

  it('answers unavailable when the listener throws', () => {
    const { ops, written, ports } = channel(true, {
      emitRequest: () => {
        throw new Error('binding broke')
      },
    })
    expect(ops.consume(editor(envelope))).toBe(true)
    expect(reply(written[0]!)).toMatchObject({ id: 'op-1', status: 'error', code: 'unavailable' })
    expect(ports.log).toHaveBeenCalledWith('pi', 'op listener failed', expect.any(Object))
    expect(ops.pendingCount).toBe(0)
  })

  it('stops the backstop when pi exits', () => {
    vi.useFakeTimers()
    const { ops, written } = channel()
    ops.consume(editor(envelope))
    ops.closed()
    vi.advanceTimersByTime(60_000)
    expect(written).toEqual([])
    expect(ops.pendingCount).toBe(0)
  })
})

describe('JsonlDecoder and a 300 KiB op request', () => {
  it('reassembles a 300 KiB editor record split across many chunks', () => {
    const prefill = 'x'.repeat(300 * 1024)
    const line = JSON.stringify({ ...editor(prefill) }) + '\n'
    const decoder = new JsonlDecoder()
    const lines: string[] = []
    const bytes = Buffer.from(line)
    for (let at = 0; at < bytes.length; at += 65_536)
      lines.push(...decoder.push(bytes.subarray(at, at + 65_536)))
    expect(lines).toHaveLength(1)
    expect((JSON.parse(lines[0]!) as { prefill: string }).prefill).toBe(prefill)
  })
})

it.each([false, true])(
  'takes the Headroom socket only from spawn inputs (inheritEnv=%s)',
  (inherit) => {
    vi.stubEnv('PHOSPHOR_HEADROOM_SOCKET', 'parent')
    try {
      expect(opChildEnv({}, inherit)).not.toHaveProperty('PHOSPHOR_HEADROOM_SOCKET')
      expect(
        opChildEnv({ PHOSPHOR_HEADROOM_SOCKET: 'owned' }, inherit).PHOSPHOR_HEADROOM_SOCKET,
      ).toBe('owned')
    } finally {
      vi.unstubAllEnvs()
    }
  },
)
