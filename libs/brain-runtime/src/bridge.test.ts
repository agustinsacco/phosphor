import { connect } from 'node:net'
import { expect, it, vi } from 'vitest'
import type { BrainAgentResponse } from '@phosphor/shared/brain'
import { createBrainBridge, type BrainCapability, type BrainBridgeRuntime } from './bridge'

function exchange(endpoint: string, token: string, method: string, params: unknown = {}) {
  return new Promise<BrainAgentResponse>((resolve, reject) => {
    const socket = connect(endpoint)
    let text = ''
    socket.setEncoding('utf8')
    socket.setTimeout(2000, () => socket.destroy(new Error('request timeout')))
    socket.on('error', reject)
    socket.on('data', (chunk: string) => {
      text += chunk
    })
    socket.once('end', () => {
      try {
        resolve(JSON.parse(text) as BrainAgentResponse)
      } catch (error) {
        reject(error)
      }
    })
    socket.once('connect', () =>
      socket.write(JSON.stringify({ version: 1, token, method, params }) + '\n'),
    )
  })
}
const working: BrainCapability = { kind: 'working', scope: '/enrolled', policyEpoch: 2 }

it('separates working and processor authority and binds delivery identity server-side', async () => {
  const invoke = vi.fn<BrainBridgeRuntime['invoke']>(async () => 'scoped result')
  const bridge = await createBrainBridge({ allowed: async () => true, invoke })
  try {
    const issued = bridge.issue(working)
    issued.bind('live-session')
    const { endpoint, token } = issued.connection
    expect(await exchange(endpoint, token, 'propose')).toMatchObject({ ok: false })
    expect(invoke).not.toHaveBeenCalled()
    expect(await exchange(endpoint, token, 'search', { scopes: ['/other'] })).toEqual({
      ok: true,
      data: 'scoped result',
    })
    expect(invoke.mock.calls[0]?.[0]).toEqual({ ...working, sessionId: 'live-session' })
    issued.revoke()
    expect(await exchange(endpoint, token, 'search')).toMatchObject({ ok: false })
    const processor = bridge.issue({ ...working, kind: 'processor', jobId: 'job', fence: 1 })
    expect(await exchange(endpoint, processor.connection.token, 'search')).toMatchObject({
      ok: false,
    })
    expect(await exchange(endpoint, processor.connection.token, 'job')).toMatchObject({ ok: true })
  } finally {
    await bridge.close()
  }
})

it('suppresses results revoked while inference or disk access is pending', async () => {
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let finish!: (value: unknown) => void
  const waiting = new Promise<unknown>((resolve) => {
    finish = resolve
  })
  const bridge = await createBrainBridge({
    allowed: async () => true,
    invoke: async () => {
      started()
      return waiting
    },
  })
  try {
    const issued = bridge.issue(working)
    const response = exchange(issued.connection.endpoint, issued.connection.token, 'read')
    await ready
    bridge.revokeAll()
    finish('private evidence must not be delivered')
    expect(await response).toEqual({ ok: false, error: 'Brain request unavailable' })
  } finally {
    finish(null)
    await bridge.close()
  }
})

it('refuses stale consent before invoking the engine and does not echo exceptions', async () => {
  let allowed = false
  const invoke = vi.fn(async () => {
    throw new Error('/private/secret/path')
  })
  const bridge = await createBrainBridge({ allowed: async () => allowed, invoke })
  try {
    const { endpoint, token } = bridge.issue(working).connection
    expect(await exchange(endpoint, token, 'read')).toMatchObject({ ok: false })
    expect(invoke).not.toHaveBeenCalled()
    allowed = true
    expect(await exchange(endpoint, token, 'read')).toEqual({
      ok: false,
      error: 'Brain request unavailable',
    })
  } finally {
    await bridge.close()
  }
})
