import { createConnection } from 'node:net'
import { expect, it, vi } from 'vitest'
import { BRAIN_PROTOCOL } from '@phosphor/shared/brain'
import { createBrainBridge } from './bridge'

function request(endpoint: string, input: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint)
    let buffer = ''
    socket.on('error', reject)
    socket.on('connect', () => socket.write(`${JSON.stringify(input)}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      if (buffer.includes('\n')) {
        socket.destroy()
        resolve(JSON.parse(buffer))
      }
    })
  })
}

it('accepts only versioned, authenticated requests with validated fields', async () => {
  const invoke = vi.fn(async () => ({
    status: 'no_match',
    hits: [],
    entities: [],
    degradation: [],
  }))
  const bridge = await createBrainBridge(invoke)
  const input = {
    version: BRAIN_PROTOCOL,
    token: bridge.token,
    method: 'search',
    params: { query: 'Harbor' },
  }
  try {
    expect(await request(bridge.endpoint, input)).toMatchObject({ ok: true })
    expect(invoke).toHaveBeenCalledWith(
      'search',
      { query: 'Harbor' },
      expect.any(AbortSignal),
      'lane',
    )
    invoke.mockClear()
    for (const patch of [
      { token: 'x'.repeat(64) },
      { version: 2 },
      { method: 'propose' },
      { method: 'related', params: { entity: 'Harbor' } },
      { params: { query: '' } },
      { params: { query: 'Harbor', scope: '/another-project' } },
    ])
      expect(await request(bridge.endpoint, { ...input, ...patch })).toEqual({
        ok: false,
        error: 'Brain request unavailable',
      })
    expect(invoke).not.toHaveBeenCalled()
  } finally {
    await bridge.close()
  }
})

it('older protocol clients fail cleanly and flags reject unknown keys and oversize fields', async () => {
  const invoke = vi.fn(async () => ({
    status: 'filed',
    message: 'Flag filed for review; Brain knowledge has not changed.',
  }))
  const bridge = await createBrainBridge(invoke)
  const params = {
    memoryId: 'harbor-fact',
    problem: 'wrong',
    reason: 'Rina verified this changed.',
    sessionId: 'harbor-lane',
    title: 'Harbor billing',
  }
  const input = { version: BRAIN_PROTOCOL, token: bridge.token, method: 'flag', params }
  try {
    expect(await request(bridge.endpoint, input)).toMatchObject({
      ok: true,
      data: { status: 'filed' },
    })
    expect(invoke).toHaveBeenCalledWith('flag', params, expect.any(AbortSignal), 'lane')
    invoke.mockClear()
    for (const patch of [
      { version: 6 },
      { unknown: true },
      { params: { ...params, unknown: true } },
      { params: { ...params, reason: 'x'.repeat(301) } },
      { params: { ...params, title: 'x'.repeat(121) } },
      { params: { ...params, problem: 'guess' } },
    ])
      expect(await request(bridge.endpoint, { ...input, ...patch })).toEqual({
        ok: false,
        error: 'Brain request unavailable',
      })
    expect(invoke).not.toHaveBeenCalled()
  } finally {
    await bridge.close()
  }
})

it('limits flags across twelve claimed sessions and sockets, while search and later flags recover', async () => {
  let now = 1000
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
  const invoke = vi.fn(async () => ({ status: 'filed', message: 'Filed.' }))
  const bridge = await createBrainBridge(invoke)
  const input = (i: number) => ({
    version: BRAIN_PROTOCOL,
    token: bridge.token,
    method: 'flag',
    params: {
      memoryId: `memory-${i}`,
      sessionId: `claimed-lane-${i}`,
      title: 'Harbor review',
      problem: 'wrong',
      reason: 'The lane verified a different policy.',
    },
  })
  try {
    const results = []
    for (let i = 0; i < 12; i++) results.push(await request(bridge.endpoint, input(i)))
    expect(results.slice(0, 10)).toEqual(
      Array.from({ length: 10 }, () => ({
        ok: true,
        data: { status: 'filed', message: 'Filed.' },
      })),
    )
    expect(results.slice(10)).toEqual(
      Array.from({ length: 2 }, () => ({
        ok: true,
        data: { status: 'limit', message: expect.any(String) },
      })),
    )
    expect(invoke).toHaveBeenCalledTimes(10)
    await request(bridge.endpoint, {
      version: BRAIN_PROTOCOL,
      token: bridge.token,
      method: 'search',
      params: { query: 'Harbor' },
    })
    expect(invoke).toHaveBeenCalledTimes(11)
    now += 60_000
    expect(await request(bridge.endpoint, input(12))).toMatchObject({
      ok: true,
      data: { status: 'filed' },
    })
  } finally {
    clock.mockRestore()
    await bridge.close()
  }
})

it('a wall-clock step back does not hold the flag window shut', async () => {
  let wall = 10_000_000_000,
    monotonic = 1000
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => wall)
  const steady = vi.spyOn(performance, 'now').mockImplementation(() => monotonic)
  const invoke = vi.fn(async () => ({ status: 'filed', message: 'Filed.' }))
  const bridge = await createBrainBridge(invoke)
  const input = (i: number) => ({
    version: BRAIN_PROTOCOL,
    token: bridge.token,
    method: 'flag',
    params: {
      memoryId: `memory-${i}`,
      sessionId: 'kestrel-lane',
      title: 'Kestrel review',
      problem: 'outdated',
      reason: 'The lane verified a newer Kestrel release date.',
    },
  })
  try {
    for (let i = 0; i < 10; i++) await request(bridge.endpoint, input(i))
    wall -= 3_600_000
    monotonic += 60_000
    expect(await request(bridge.endpoint, input(10))).toMatchObject({
      ok: true,
      data: { status: 'filed' },
    })
  } finally {
    clock.mockRestore()
    steady.mockRestore()
    await bridge.close()
  }
})
