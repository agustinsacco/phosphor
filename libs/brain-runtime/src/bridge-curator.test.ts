import { createConnection, type Socket } from 'node:net'
import { expect, it, vi } from 'vitest'
import { BRAIN_PROTOCOL } from '@phosphor/shared/brain'
import { BRAIN_CURATOR_METHODS, BRAIN_LANE_METHODS } from '@phosphor/shared/brain-agent'
import { createBrainBridge } from './bridge'

const DENIED = { ok: false, error: 'Brain request unavailable' }
const reason = 'Both records name the same Slack user.'
const PARAMS: Record<string, unknown> = {
  search: { query: 'Harbor' },
  flag: {
    memoryId: 'ownership',
    problem: 'wrong',
    reason: 'Tom Lee owns it now.',
    sessionId: 'harbor-lane',
    title: 'Harbor billing',
  },
  waiting: {},
  suggestion: { suggestionId: 'sugg-rina' },
  entity: { entityId: 'rina' },
  memory: { memoryId: 'ownership' },
  relate: {
    subjectId: 'rina',
    objectId: 'harbor',
    predicate: 'owns',
    label: 'owns',
    memoryIds: ['ownership'],
    reason,
  },
  resolve: { suggestionId: 'sugg-rina', action: { kind: 'keep' }, reason },
  edit: { edit: { kind: 'merge', sourceId: 'rina-2', targetId: 'rina' }, reason },
  correct: {
    memoryId: 'ownership',
    summary: 'Tom Lee owns it.',
    source: 'Linear KES-12',
    quote: 'Tom owns it',
    reason,
  },
  erase: { memoryId: 'ownership', reason },
  undo: { operationId: 'op-1', reason },
}

function open(endpoint: string, input: unknown): { socket: Socket; reply: Promise<unknown> } {
  const socket = createConnection(endpoint)
  const reply = new Promise<unknown>((resolve, reject) => {
    let buffer = ''
    socket.on('error', reject)
    socket.on('close', () => resolve(buffer ? JSON.parse(buffer) : 'closed'))
    socket.on('connect', () => socket.write(`${JSON.stringify(input)}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
    })
  })
  return { socket, reply }
}
const call = (endpoint: string, token: string, method: string, params = PARAMS[method]) =>
  open(endpoint, { version: BRAIN_PROTOCOL, token, method, params }).reply

it('holds two different tokens, and the lane token calls only search and flag', async () => {
  const invoke = vi.fn(async () => ({ ok: 'yes' }))
  const bridge = await createBrainBridge(invoke)
  try {
    expect(bridge.curatorToken).toMatch(/^[0-9a-f]{64}$/)
    expect(bridge.curatorToken).not.toBe(bridge.token)
    for (const method of BRAIN_LANE_METHODS)
      expect(await call(bridge.endpoint, bridge.token, method)).toEqual({
        ok: true,
        data: { ok: 'yes' },
      })
    invoke.mockClear()
    for (const method of BRAIN_CURATOR_METHODS.filter((m) => m !== 'search'))
      expect(await call(bridge.endpoint, bridge.token, method), method).toEqual(DENIED)
    expect(invoke).not.toHaveBeenCalled()
  } finally {
    await bridge.close()
  }
})

it('the curator token calls every curator method and never flag', async () => {
  const invoke = vi.fn(async (_method: string) => ({ ok: 'yes' }))
  const bridge = await createBrainBridge(invoke)
  try {
    for (const method of BRAIN_CURATOR_METHODS)
      expect(await call(bridge.endpoint, bridge.curatorToken, method), method).toEqual({
        ok: true,
        data: { ok: 'yes' },
      })
    expect(invoke.mock.calls.map(([method]) => method)).toEqual([...BRAIN_CURATOR_METHODS])
    // The runtime learns which token asked: Brain Agent's search ignores any lane's project.
    expect(new Set(invoke.mock.calls.map((args) => (args as unknown[])[3]))).toEqual(
      new Set(['curator']),
    )
    invoke.mockClear()
    expect(await call(bridge.endpoint, bridge.curatorToken, 'flag')).toEqual(DENIED)
    expect(await call(bridge.endpoint, bridge.curatorToken, 'propose', {})).toEqual(DENIED)
    expect(invoke).not.toHaveBeenCalled()
  } finally {
    await bridge.close()
  }
})

it('a wrong or near-miss token gets the same refusal as today', async () => {
  const invoke = vi.fn(async () => ({}))
  const bridge = await createBrainBridge(invoke)
  try {
    const nearMiss = `${bridge.curatorToken.slice(0, -1)}${bridge.curatorToken.endsWith('0') ? '1' : '0'}`
    for (const token of ['x'.repeat(64), nearMiss, `${bridge.token}${bridge.curatorToken}`, ''])
      for (const method of ['search', 'waiting', 'erase'])
        expect(await call(bridge.endpoint, token, method)).toEqual(DENIED)
    expect(invoke).not.toHaveBeenCalled()
  } finally {
    await bridge.close()
  }
})

it('says why a curator request or call was refused, without paths or stacks', async () => {
  const invoke = vi.fn(async (method: string) => {
    if (method === 'entity') throw new Error('Brain entity not found.')
    throw new Error(
      "ENOENT: no such file or directory, open '/Users/rina/.pi/agent/sessions/x.jsonl'\n    at open",
    )
  })
  const bridge = await createBrainBridge(invoke)
  try {
    expect(await call(bridge.endpoint, bridge.curatorToken, 'entity')).toEqual({
      ok: false,
      error: 'Brain entity not found.',
    })
    const failed = (await call(bridge.endpoint, bridge.curatorToken, 'memory')) as { error: string }
    expect(failed.error).not.toMatch(/Users|sessions|\n| at /)
    expect(
      await call(bridge.endpoint, bridge.curatorToken, 'erase', {
        memoryId: 'ownership',
        reason: '',
      }),
    ).toEqual({ ok: false, error: 'Brain reason needs 1 to 300 characters.' })
    // Lane agents keep today's single refusal.
    expect(await call(bridge.endpoint, bridge.token, 'search', { query: '' })).toEqual(DENIED)
  } finally {
    await bridge.close()
  }
})

it('keeps an authenticated curator call open past the idle timeout and aborts it when the socket closes', async () => {
  let signal: AbortSignal | undefined
  let finish: ((value: unknown) => void) | undefined
  const invoke = vi.fn(
    (_method: string, _params: unknown, abort?: AbortSignal) =>
      new Promise((resolve) => {
        signal = abort
        finish = resolve
      }),
  )
  const bridge = await createBrainBridge(invoke, { idleMs: 40, curatorIdleMs: 2000 })
  try {
    // Unauthenticated sockets still close at the short idle timeout.
    const idle = createConnection(bridge.endpoint)
    expect(await new Promise((resolve) => idle.on('close', () => resolve('closed')))).toBe('closed')

    const slow = open(bridge.endpoint, {
      version: BRAIN_PROTOCOL,
      token: bridge.curatorToken,
      method: 'search',
      params: { from: 'Harbor' },
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(signal?.aborted).toBe(false)
    finish!({ ok: 'late' })
    expect(await slow.reply).toEqual({ ok: true, data: { ok: 'late' } })

    const dropped = open(bridge.endpoint, {
      version: BRAIN_PROTOCOL,
      token: bridge.curatorToken,
      method: 'correct',
      params: PARAMS.correct,
    })
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
    expect(signal?.aborted).toBe(false)
    dropped.socket.destroy()
    await vi.waitFor(() => expect(signal?.aborted).toBe(true))
  } finally {
    await bridge.close()
  }
})
