import { describe, expect, it, vi } from 'vitest'
import { openOwnerChannel, type OwnerChannelPorts } from './owner-channel'

const IDENTITY = { machineId: '00000000-0000-4000-8000-0000000000bb', publicKey: 'k' }

function ports(states: string[], over: Partial<OwnerChannelPorts> = {}) {
  const close = vi.fn()
  const call = vi.fn(async () => ({ type: 'result', id: '1', ok: true, data: { ok: 1 } }))
  const connect: NonNullable<OwnerChannelPorts['connect']> = (_identity, connection) => {
    let state = 'connecting'
    for (const [i, next] of states.entries())
      setTimeout(() => {
        state = next
        connection.changed()
      }, i + 1)
    return { snapshot: () => ({ state }) as never, call: call as never, close }
  }
  const all: OwnerChannelPorts = {
    location: { kind: 'dev', socket: '/nonexistent/s.sock', configDir: '/nonexistent/c' },
    ownerKey: () => Promise.reject(new Error('unused')),
    identity: () => IDENTITY as never,
    connect,
    timeoutMs: 50,
    ...over,
  }
  return { all, close, call }
}

describe('openOwnerChannel', () => {
  it('resolves once the connection is ready, and calls go through it', async () => {
    const p = ports(['reconnecting', 'ready'])
    const channel = await openOwnerChannel(p.all)
    expect(channel?.machineId).toBe(IDENTITY.machineId)
    await expect(
      channel!.call('owner.migrate.status', { migrationId: IDENTITY.machineId }),
    ).resolves.toEqual({ ok: 1 })
    channel!.close()
    expect(p.close).toHaveBeenCalledTimes(1)
  })

  it('is null, and closes the connection, when the service does not answer in time', async () => {
    const p = ports([])
    expect(await openOwnerChannel(p.all)).toBeNull()
    expect(p.close).toHaveBeenCalledTimes(1)
  })

  it('is null at once on a state that cannot become ready, or with no identity yet', async () => {
    const p = ports(['wrong-machine'], { timeoutMs: 10_000 })
    expect(await openOwnerChannel(p.all)).toBeNull()
    expect(await openOwnerChannel({ ...p.all, identity: () => null })).toBeNull()
  })
})
