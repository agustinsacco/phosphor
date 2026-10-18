// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ClaudeReadiness, claudeReadiness } from './ClaudeReadiness'
import { MachinesPage } from './MachinesPage'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useMachinesStore } from '@/stores/machines'
import { MACHINE } from './__fixtures__/control'

it('identifies each missing Claude part before offering sign-in', () => {
  for (const provider of ['missing', 'outdated'] as const)
    expect(claudeReadiness({ provider, cli: 'ok', auth: 'ok' }).command).toBe(
      'pi install npm:@saccolabs/pi-claude-cli',
    )
  expect(claudeReadiness({ provider: 'ok', cli: 'missing', auth: 'ok' }).command).toBe(
    'phosphor setup',
  )
  expect(claudeReadiness({ provider: 'ok', cli: 'ok', auth: 'signed-out' }).command).toBe(
    'phosphor providers login claude',
  )
  expect(claudeReadiness({ provider: 'ok', cli: 'ok', auth: 'unknown' }).ok).toBe(false)
  expect(claudeReadiness({ provider: 'ok', cli: 'ok', auth: 'ok' }).ok).toBe(true)
})
it('falls back for an old Host and re-reads Claude and providers with Check again', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const invoke = vi.fn(async (channel: string): Promise<unknown> => {
    if (channel === 'account:get')
      return { account: { status: 'signed-in', user: { login: 'test' } } }
    if (channel === 'hosts:providers' || channel === 'pi:subscriptionAuth') return []
    if (channel === 'control:machines')
      return { ok: true, machines: [machine], serverTime: new Date().toISOString() }
    return null
  })
  vi.stubGlobal('phosphor', { invoke, onAccountChanged: () => () => {} })
  const machine = {
    ...MACHINE,
    lastSeenAt: new Date().toISOString(),
    state: 'running' as const,
    endpoint: 'https://host.example:47615',
  }
  useMachinesStore.setState({
    remoteEnabled: true,
    machines: [machine],
    view: { kind: 'machine', id: MACHINE.id },
    nowMs: Date.now(),
  })
  useRemoteLanesStore.setState({
    hosts: {
      [MACHINE.id]: {
        connectionToken: 'test-connection',
        state: 'ready',
        capabilities: ['skills.read'],
        repositories: [],
        lanes: [],
      },
    },
  })
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () => root.render(<MachinesPage />))
    expect(invoke).toHaveBeenCalledWith('hosts:claude', MACHINE.id)
    expect(container.textContent).toContain('Sign in to Claude Code on this machine.')
    invoke.mockClear()
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'hosts:claude') return { provider: 'missing', cli: 'ok', auth: 'ok' }
      if (channel === 'hosts:providers') return []
      if (channel === 'control:machines')
        return { ok: true, machines: [machine], serverTime: new Date().toISOString() }
      return null
    })
    await act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((b) => b.textContent === 'Check again')
        ?.click(),
    )
    expect(invoke).toHaveBeenCalledWith('control:machines')
    expect(invoke).toHaveBeenCalledWith('hosts:providers', MACHINE.id)
    expect(invoke).toHaveBeenCalledWith('hosts:claude', MACHINE.id)
    expect(container.textContent).toContain('Claude Code provider missing')
    expect(container.textContent).toContain('pi install npm:@saccolabs/pi-claude-cli')
  } finally {
    act(() => root.unmount())
    useRemoteLanesStore.setState({ hosts: {} })
    useMachinesStore.getState().enableRemote(false)
    vi.unstubAllGlobals()
  }
})
it.each([
  {
    provider: 'missing',
    cli: 'ok',
    auth: 'ok',
    text: 'Claude Code provider missing',
    command: 'pi install npm:@saccolabs/pi-claude-cli',
  },
  {
    provider: 'outdated',
    cli: 'ok',
    auth: 'ok',
    text: 'Claude Code provider outdated',
    command: 'pi install npm:@saccolabs/pi-claude-cli',
  },
  {
    provider: 'ok',
    cli: 'missing',
    auth: 'ok',
    text: 'Claude Code is missing',
    command: 'phosphor setup',
  },
  {
    provider: 'ok',
    cli: 'ok',
    auth: 'signed-out',
    text: 'Sign in to Claude Code',
    command: 'phosphor providers login claude',
  },
  { provider: 'ok', cli: 'ok', auth: 'ok', text: 'Signed in and ready', command: undefined },
] as const)(
  'renders Claude $provider / $cli / $auth with its exact fix',
  async ({ provider, cli, auth, text, command }) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const invoke = vi.fn(async (channel: string): Promise<unknown> => {
      if (channel === 'account:get')
        return { account: { status: 'signed-in', user: { login: 'test' } } }
      if (channel === 'hosts:claude') return { provider, cli, auth }
      if (channel === 'hosts:providers' || channel === 'pi:subscriptionAuth') return []
      return null
    })
    vi.stubGlobal('phosphor', { invoke, onAccountChanged: () => () => {} })
    useMachinesStore.setState({
      remoteEnabled: true,
      machines: [{ ...MACHINE, lastSeenAt: new Date().toISOString(), state: 'running' }],
      view: { kind: 'machine', id: MACHINE.id },
      nowMs: Date.now(),
    })
    useRemoteLanesStore.setState({
      hosts: {
        [MACHINE.id]: {
          connectionToken: 'test',
          state: 'ready',
          capabilities: ['skills.read'],
          repositories: [],
          lanes: [],
        },
      },
    })
    const container = document.createElement('div')
    const root = createRoot(container)
    try {
      await act(async () => root.render(<MachinesPage />))
      expect([...container.querySelectorAll('h4')].map((h) => h.textContent)).toContain(
        'Claude Code',
      )
      expect(container.textContent).toContain(text)
      if (command)
        expect([...container.querySelectorAll('code')].map((c) => c.textContent)).toContain(command)
    } finally {
      act(() => root.unmount())
      useRemoteLanesStore.setState({ hosts: {} })
      useMachinesStore.getState().enableRemote(false)
      vi.unstubAllGlobals()
    }
  },
)

it('labels the detailed provider as Claude Code, distinct from native Claude Pro/Max', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(
        <ClaudeReadiness check={claudeReadiness({ provider: 'ok', cli: 'ok', auth: 'ok' })} />,
      ),
    )
    expect(container.querySelector('p')?.textContent).toBe('Claude Code: Signed in and ready')
  } finally {
    act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})
