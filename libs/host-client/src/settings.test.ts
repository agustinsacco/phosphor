import { describe, expect, it, vi } from 'vitest'
import type { createHostConnection } from './connection'
import { machineSettings } from './settings'
const revision = 'a'.repeat(64)
const data = {
  section: 'agent',
  revision,
  agent: { defaultModel: 'remote', contextBudget: '200k', autoNameLanes: true },
}
function fixture() {
  let generation = 1
  const view = {
    state: 'ready',
    capabilities: ['machine.configure', 'sessions.control'],
    lanes: [{ laneId: 'lane', control: { fence: 4 } }],
  }
  const fake = {
    snapshot: () => view,
    incarnation: () => ({ generation }),
    call: vi.fn(async () => ({ ok: true, data })),
    send: vi.fn(async () => ({ status: 'done' })),
  }
  let current = fake as unknown as ReturnType<typeof createHostConnection> | undefined
  return {
    api: machineSettings(() => current),
    fake,
    view,
    replace: () => {
      current = undefined
    },
    reconnect: () => {
      generation++
    },
  }
}
describe('Host machine settings boundary', () => {
  it('uses only the named Host and projects approved fields', async () => {
    const f = fixture()
    f.fake.call.mockResolvedValue({
      ok: true,
      data: {
        ...data,
        credentials: { token: 'SECRET' },
        agent: { ...data.agent, privateKey: 'PRIVATE' },
      },
    } as never)
    expect(await f.api.read('bee1', 'agent')).toEqual(data)
    expect(f.fake.call).toHaveBeenCalledWith('machine.settings.read', { section: 'agent' })
  })
  it.each(['replaced', 'reconnected', 'revoked'] as const)(
    'does not publish a %s connection’s late result',
    async (kind) => {
      const f = fixture()
      let finish!: (value: { ok: true; data: typeof data }) => void
      f.fake.call.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
      const pending = f.api.read('bee1', 'agent')
      if (kind === 'replaced') f.replace()
      if (kind === 'reconnected') f.reconnect()
      if (kind === 'revoked') f.view.capabilities = ['sessions.control']
      finish({ ok: true, data })
      await expect(pending).rejects.toThrow('not confirmed')
    },
  )
  it('never falls back to local settings when disconnected or unprivileged', async () => {
    const f = fixture()
    f.view.capabilities = ['sessions.control']
    await expect(f.api.read('bee1', 'agent')).rejects.toThrow('configuration access')
    expect(f.fake.call).not.toHaveBeenCalled()
    f.replace()
    await expect(f.api.read('bee1', 'agent')).rejects.toThrow('configuration access')
  })
  it('rejects wrong-section or wrong-folder Host responses', async () => {
    const f = fixture()
    await expect(f.api.read('bee1', 'agent', '0123456789abcdef')).rejects.toThrow(
      'invalid settings',
    )
    f.fake.call.mockResolvedValue({ ok: true, data: { ...data, section: 'advanced' } } as never)
    await expect(f.api.read('bee1', 'agent')).rejects.toThrow('invalid settings')
  })
  it('moves a known Host lane with its fence, never taking another client’s control', async () => {
    const f = fixture()
    await f.api.moveAccount('bee1', 'lane', 'default')
    expect(f.fake.send).toHaveBeenCalledWith(
      { type: 'claude.account', accountId: 'default' },
      'lane',
      4,
    )
    await expect(f.api.moveAccount('bee1', 'not-on-host', 'default')).rejects.toThrow(
      'Open this Host lane',
    )
    f.fake.send.mockResolvedValue({ status: 'unknown' })
    await expect(f.api.moveAccount('bee1', 'lane', 'default')).rejects.toThrow('not confirmed')
  })
})
