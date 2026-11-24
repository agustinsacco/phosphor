import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { OP_CHANNEL_LIMITS, type OpReplyEnvelope } from '@phosphor/shared/ops'
import type { ExtensionUIRequest, ExtensionUIResponse } from '@shared/rpc'
import { PiRpcClient } from './rpc-client'
import type { OpChannelRequestEvent } from './op-channel'

const FIXTURE = join(import.meta.dirname, '__fixtures__', 'op-pi.cjs')
const MARKER = { PHOSPHOR_OPS: 'v1' }
const clients: PiRpcClient[] = []

function start(env: Record<string, string> = MARKER, log = vi.fn()) {
  const client = new PiRpcClient(
    { cwd: import.meta.dirname, binaryPath: process.execPath, prefixArgs: [FIXTURE], env },
    { log, isClosing: () => false },
  )
  clients.push(client)
  const answers: { response: ExtensionUIResponse; duplicate: boolean }[] = []
  const dialogs: ExtensionUIRequest[] = []
  client.on('event', (event) => {
    const record = event as unknown as { type: string; response: ExtensionUIResponse }
    if (record.type === 'fake_ui_response')
      answers.push(record as unknown as { response: ExtensionUIResponse; duplicate: boolean })
  })
  client.on('extension-ui', (request) => dialogs.push(request))
  client.spawn()
  return { client, answers, dialogs, log }
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.dispose()))
})

const envelope = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, id: 'op-1', argv: ['lane', 'list'], deadlineMs: 30_000, ...extra })
const editor = (prefill: string, id = 'editor-1') => ({
  id,
  method: 'editor',
  title: 'phosphor-op/v1',
  prefill,
})
const script = (requests: object[], exitAfterMs?: number) =>
  JSON.stringify({ requests, ...(exitAfterMs === undefined ? {} : { exitAfterMs }) })
const replyOf = (answer: { response: ExtensionUIResponse }): OpReplyEnvelope =>
  JSON.parse((answer.response as { value: string }).value) as OpReplyEnvelope

function nextOp(client: PiRpcClient): Promise<OpChannelRequestEvent> {
  return new Promise((resolve) => client.once('phosphor-op', resolve))
}
async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('PiRpcClient op channel', () => {
  it('consumes a marker session op request: no extension-ui, not busy, one phosphor-op', async () => {
    const { client, answers, dialogs } = start()
    const dialog = vi.spyOn(client.activity, 'dialog')
    const op = nextOp(client)
    await client.request({ type: 'prompt', message: script([editor(envelope())]) })
    const event = await op
    expect(event.request).toMatchObject({ id: 'op-1', argv: ['lane', 'list'] })
    expect(dialogs).toEqual([])
    // No dialog flag: the op never holds the lane busy the way a user dialog does.
    expect(dialog).not.toHaveBeenCalled()
    expect(client.pendingOps).toBe(1)
    event.respond({ v: 1, id: 'op-1', status: 'ok', text: 'first', applies: 'now' })
    event.respond({ v: 1, id: 'op-1', status: 'ok', text: 'second', applies: 'now' })
    await until(() => answers.length > 0)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(answers).toHaveLength(1)
    expect(answers[0]!.response.id).toBe('editor-1')
    expect(replyOf(answers[0]!)).toMatchObject({ status: 'ok', text: 'first' })
    expect(client.pendingOps).toBe(0)
  })

  it('passes the same request through as extension-ui without the marker', async () => {
    const { client, dialogs } = start({})
    const listener = vi.fn()
    client.on('phosphor-op', listener)
    await client.request({ type: 'prompt', message: script([editor(envelope())]) })
    await until(() => dialogs.length > 0)
    expect(dialogs[0]).toMatchObject({ id: 'editor-1', method: 'editor', title: 'phosphor-op/v1' })
    expect(listener).not.toHaveBeenCalled()
  })

  it('ignores an inherited marker: the spawn env decides, and pi does not receive it', async () => {
    vi.stubEnv('PHOSPHOR_OPS', 'v1')
    try {
      const { client, dialogs } = start({})
      const state = await client.request({ type: 'get_state' })
      const data = (state as unknown as { data: { opsMarker: string | null } }).data
      expect(data.opsMarker).toBeNull()
      await client.request({ type: 'prompt', message: script([editor(envelope())]) })
      await until(() => dialogs.length > 0)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('answers no-owner at once when nothing listens for phosphor-op', async () => {
    const { client, answers, dialogs } = start()
    const sent = Date.now()
    await client.request({ type: 'prompt', message: script([editor(envelope())]) })
    await until(() => answers.length > 0, 100 + (Date.now() - sent))
    expect(replyOf(answers[0]!)).toEqual({
      v: 1,
      id: 'op-1',
      status: 'unsupported',
      code: 'no-owner',
    })
    expect(dialogs).toEqual([])
  })

  it.each([
    ['bad JSON', '{not json'],
    ['a wrong version', JSON.stringify({ v: 2, id: 'op-1', argv: [], deadlineMs: 1 })],
    ['a missing id', JSON.stringify({ v: 1, argv: [], deadlineMs: 1 })],
  ])('answers %s bad-request, logs once and emits nothing', async (_name, prefill) => {
    const { client, answers, dialogs, log } = start()
    const listener = vi.fn()
    client.on('phosphor-op', listener)
    await client.request({ type: 'prompt', message: script([editor(prefill)]) })
    await until(() => answers.length > 0)
    expect(replyOf(answers[0]!)).toMatchObject({ status: 'error', code: 'bad-request', id: null })
    expect(listener).not.toHaveBeenCalled()
    expect(dialogs).toEqual([])
    expect(log.mock.calls.filter(([, message]) => message === 'op malformed')).toHaveLength(1)
  })

  it('reads a prefill of exactly prefillBytes and refuses one byte more', async () => {
    const body = envelope()
    const exact = body + ' '.repeat(OP_CHANNEL_LIMITS.prefillBytes - body.length)
    const { client, answers } = start()
    const op = nextOp(client)
    await client.request({
      type: 'prompt',
      message: script([editor(exact, 'exact'), editor(exact + ' ', 'over')]),
    })
    const event = await op
    expect(event.request.id).toBe('op-1')
    await until(() => answers.length > 0)
    expect(answers[0]!.response.id).toBe('over')
    expect(replyOf(answers[0]!)).toMatchObject({ status: 'error', code: 'bad-request' })
    event.respond({ v: 1, id: 'op-1', status: 'ok', text: 'done', applies: 'now' })
    await until(() => answers.length > 1)
  })

  it('round-trips a 256 KiB content argument full of quotes and newlines', async () => {
    const content = '"\n'.repeat(128 * 1024)
    const { client, answers } = start()
    const op = nextOp(client)
    await client.request({
      type: 'prompt',
      message: script([editor(envelope({ argv: ['skill', 'edit', 'x'], content }))]),
    })
    const event = await op
    expect(event.request.content).toBe(content)
    const text = 'x'.repeat(300 * 1024)
    event.respond({ v: 1, id: 'op-1', status: 'ok', text, applies: 'now' })
    await until(() => answers.length > 0)
    expect(replyOf(answers[0]!)).toMatchObject({ text })
  })

  it('answers every pending id aborted on Stop without waiting for the abort ack', async () => {
    const { client, answers } = start()
    const ops: OpChannelRequestEvent[] = []
    const stopped = vi.fn()
    client.on('phosphor-op', (event) => ops.push(event))
    client.on('phosphor-op-stop', stopped)
    await client.request({
      type: 'prompt',
      message: script([editor(envelope(), 'a'), editor(envelope({ id: 'op-2' }), 'b')]),
    })
    await until(() => ops.length === 2)
    // The fixture, like pi, acknowledges abort only once no editor is pending.
    expect((await client.request({ type: 'abort' })).success).toBe(true)
    expect(answers.map((answer) => [answer.response.id, replyOf(answer)])).toEqual([
      ['a', { v: 1, id: 'op-1', status: 'error', code: 'aborted', text: expect.any(String) }],
      ['b', { v: 1, id: 'op-2', status: 'error', code: 'aborted', text: expect.any(String) }],
    ])
    expect(stopped).toHaveBeenCalledOnce()
    ops[0]!.respond({ v: 1, id: 'op-1', status: 'ok', text: 'late', applies: 'now' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(answers).toHaveLength(2)
  })

  it('drops every pending id when pi exits, and a late respond writes nothing', async () => {
    const { client } = start()
    const op = nextOp(client)
    const exited = new Promise((resolve) => client.once('exit', resolve))
    await client.request({ type: 'prompt', message: script([editor(envelope())], 50) })
    const event = await op
    expect(client.pendingOps).toBe(1)
    await exited
    expect(client.pendingOps).toBe(0)
    expect(() =>
      event.respond({ v: 1, id: 'op-1', status: 'ok', text: 'late', applies: 'now' }),
    ).not.toThrow()
  })

  it('answers lane.liveness ok and reports the count, never as an op', async () => {
    const { client, answers } = start()
    const listener = vi.fn()
    const liveness = vi.fn()
    client.on('phosphor-op', listener)
    client.on('lane-liveness', liveness)
    const prefill = JSON.stringify({ v: 1, id: 'live-1', op: 'lane.liveness', subagents: 3 })
    await client.request({ type: 'prompt', message: script([editor(prefill)]) })
    await until(() => answers.length > 0)
    expect(replyOf(answers[0]!)).toMatchObject({ id: 'live-1', status: 'ok' })
    expect(liveness).toHaveBeenCalledExactlyOnceWith(3)
    expect(listener).not.toHaveBeenCalled()
  })
})
