import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeGrant, type GrantPayload } from '@shared/host-grant'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}))
vi.mock('./handle', () => ({
  handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
    mocks.handlers.set(channel, handler),
}))
vi.mock('../pty/pty-manager', () => ({ ptyManager: { createHome: vi.fn() } }))

import { registerHostSettingsHandlers } from './host-settings-handlers'

const hostId = '11111111-1111-4111-8111-111111111111'
const event = { sender: { id: 7 } }
function grantToken(configure: boolean): string {
  const now = Math.floor(Date.now() / 1000)
  const payload: GrantPayload = {
    v: 1,
    iss: 'https://control.invalid',
    kid: 'fixture',
    sub: '22222222-2222-4222-8222-222222222222',
    sid: '33333333-3333-4333-8333-333333333333',
    hostId,
    epoch: 1,
    client: { id: '44444444-4444-4444-8444-444444444444', label: 'Fixture' },
    caps: ['sessions.read', 'sessions.control'],
    ...(configure ? { configure: true as const } : {}),
    iat: now,
    exp: now + 300,
    jti: '0123456789abcdef',
  }
  return encodeGrant(payload, () => new Uint8Array(64))
}
function setup(view: Record<string, unknown> = {}) {
  mocks.handlers.clear()
  const snapshot = {
    state: 'ready',
    configurationSupported: true,
    capabilities: ['sessions.control', 'machine.configure'],
    lanes: [],
    ...view,
  }
  const connection = {
    snapshot: () => snapshot,
    incarnation: () => ({ generation: 1 }),
    call: vi.fn(async () => ({ ok: true, data: {} })),
    send: vi.fn(),
  }
  const manager = {
    connection: vi.fn((id: string) => (id === hostId ? connection : undefined)),
    reconnect: vi.fn(async () => {}),
  }
  const grants = {
    configure: vi.fn(),
    grantFor: vi.fn(async () => ({ grant: grantToken(true) })),
  }
  const terminals = { task: vi.fn(), signIn: vi.fn(), shell: vi.fn() }
  registerHostSettingsHandlers(manager as never, grants as never, terminals as never)
  const invoke = async (channel: string, ...args: unknown[]) =>
    mocks.handlers.get(channel)!(event, ...args)
  return { manager, grants, terminals, connection, snapshot, invoke }
}

describe('Desktop hosts:settingsAccess', () => {
  beforeEach(() => mocks.handlers.clear())
  it('asks for a configure grant, verifies it carries configure, then reconnects', async () => {
    const s = setup()
    await s.invoke('hosts:settingsAccess', hostId)
    expect(s.grants.configure).toHaveBeenCalledTimes(1)
    expect(s.grants.configure).toHaveBeenCalledWith(hostId)
    expect(s.grants.grantFor).toHaveBeenCalledWith(hostId)
    expect(s.manager.reconnect).toHaveBeenCalledWith(hostId)
  })
  it.each([
    ['not ready', { state: 'reconnecting' }],
    ['an older Host', { configurationSupported: false }],
  ])('refuses %s before asking for any grant', async (_name, view) => {
    const s = setup(view)
    await expect(s.invoke('hosts:settingsAccess', hostId)).rejects.toThrow(
      'Connect to an updated Host before enabling settings access.',
    )
    await expect(s.invoke('hosts:settingsAccess', 'unknown')).rejects.toThrow(
      'Connect to an updated Host',
    )
    expect(s.grants.configure).not.toHaveBeenCalled()
    expect(s.manager.reconnect).not.toHaveBeenCalled()
  })
  it.each([
    ['a grant without configure', 'plain'],
    ['a refused grant', 'refused'],
    ['an unparseable grant', 'garbage'],
  ])('rolls the opt-in back after %s and keeps the link', async (_name, kind) => {
    const s = setup()
    if (kind === 'plain') s.grants.grantFor.mockResolvedValue({ grant: grantToken(false) })
    if (kind === 'refused') s.grants.grantFor.mockRejectedValue(new Error('grant-refused'))
    if (kind === 'garbage') s.grants.grantFor.mockResolvedValue({ grant: 'not-a-grant' })
    await expect(s.invoke('hosts:settingsAccess', hostId)).rejects.toThrow(
      'The control plane did not grant configuration access. Update it or sign in again, then retry. Existing lane access was not changed.',
    )
    expect(s.grants.configure.mock.calls).toEqual([[hostId], [hostId, false]])
    expect(s.manager.reconnect).not.toHaveBeenCalled()
  })
})

describe('Desktop Host settings channels', () => {
  it('reads, checks and patches only through the named ready Host connection', async () => {
    const s = setup()
    s.connection.call.mockResolvedValue({
      ok: true,
      data: {
        section: 'agent',
        revision: 'a'.repeat(64),
        agent: { defaultModel: 'remote', contextBudget: '200k', autoNameLanes: true },
      },
    })
    await s.invoke('hosts:settingsRead', hostId, 'agent')
    expect(s.connection.call).toHaveBeenLastCalledWith('machine.settings.read', {
      section: 'agent',
    })
    s.snapshot.capabilities = ['sessions.control']
    await expect(s.invoke('hosts:settingsRead', hostId, 'agent')).rejects.toThrow(
      'enable configuration access first',
    )
    await expect(s.invoke('hosts:settingsCheck', hostId)).rejects.toThrow(
      'enable configuration access first',
    )
    await expect(
      s.invoke('hosts:settingsPatch', hostId, {
        section: 'agent',
        revision: 'a'.repeat(64),
        change: { type: 'agent.patch', patch: { autoNameLanes: false } },
      }),
    ).rejects.toThrow('enable configuration access first')
    expect(s.connection.call).toHaveBeenCalledTimes(1)
  })
  it('runs machine tasks in a Host terminal for the calling window', async () => {
    const s = setup()
    await s.invoke('hosts:machineTask', hostId, { type: 'machine.task', task: 'claude.installCli' })
    expect(s.terminals.task).toHaveBeenCalledWith(7, hostId, {
      type: 'machine.task',
      task: 'claude.installCli',
    })
  })
  it('refuses a Claude account move without configuration access', async () => {
    const s = setup({ capabilities: ['sessions.control'] })
    await expect(s.invoke('hosts:claudeAccount', hostId, 'lane', 'a'.repeat(16))).rejects.toThrow()
    expect(s.connection.send).not.toHaveBeenCalled()
  })
})
