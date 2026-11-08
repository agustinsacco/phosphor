import { createConnection } from 'node:net'
import { expect, it, vi } from 'vitest'
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

it('accepts only versioned, authenticated search/related with validated requests', async () => {
  const invoke = vi.fn(async () => ({
    status: 'no_match',
    hits: [],
    entities: [],
    degradation: [],
  }))
  const bridge = await createBrainBridge(invoke)
  const input = { version: 2, token: bridge.token, method: 'search', params: { query: 'Harbor' } }
  try {
    expect(await request(bridge.endpoint, input)).toMatchObject({ ok: true })
    expect(invoke).toHaveBeenCalledWith('search', { query: 'Harbor' })
    invoke.mockClear()
    for (const patch of [
      { token: 'x'.repeat(64) },
      { version: 1 },
      { method: 'propose' },
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
