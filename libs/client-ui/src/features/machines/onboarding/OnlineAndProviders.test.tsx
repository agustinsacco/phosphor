// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { OnlineAndProviders } from './OnlineAndProviders'
import { MACHINE } from '../__fixtures__/control'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useMachinesStore } from '@/stores/machines'
import type { HostCapability } from '@shared/remote-host'

const readyHost = (capabilities: HostCapability[]) => ({
  [MACHINE.id]: {
    connectionToken: 'test-connection',
    state: 'ready' as const,
    capabilities,
    repositories: [],
    lanes: [],
  },
})

it('follows directory online state and reads provider readiness without owning sign-in', async () => {
  const invoke = vi.fn(async (channel: string) =>
    channel === 'hosts:providers'
      ? [
          { id: 'anthropic', name: 'Anthropic', status: 'ready' },
          { id: 'openai', name: 'OpenAI', status: 'not_ready' },
        ]
      : null,
  )
  vi.stubGlobal('phosphor', { invoke })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useRemoteLanesStore.setState({ hosts: {} })
  const now = Date.now()
  useMachinesStore.setState({ machines: [MACHINE], nowMs: now, clockOffsetMs: 0 })
  const container = document.createElement('div')
  const root = createRoot(container)
  const open = vi.fn()
  const next = vi.fn()
  const render = async (providers: boolean) =>
    act(async () =>
      root.render(
        <OnlineAndProviders
          added={MACHINE}
          providers={providers}
          onOpen={open}
          onProviders={next}
        />,
      ),
    )
  try {
    await render(false)
    expect(container.textContent).toContain('Waiting for the first connection')
    await act(async () =>
      useMachinesStore.setState({
        machines: [{ ...MACHINE, lastSeenAt: new Date(now).toISOString(), state: 'running' }],
      }),
    )
    await act(async () => useRemoteLanesStore.setState({ hosts: readyHost([]) }))
    expect(container.textContent).toContain('bee1 is online')
    await act(async () => useMachinesStore.setState({ nowMs: now + 600000 }))
    await act(async () => useRemoteLanesStore.setState({ hosts: {} }))
    expect(container.textContent).toContain('not reachable')
    await act(async () => useRemoteLanesStore.setState({ hosts: readyHost(['skills.read']) }))
    await render(true)
    expect(invoke).toHaveBeenCalledWith('hosts:providers', MACHINE.id)
    const row = (id: string) => container.querySelector(`[data-provider=${id}]`)?.textContent
    expect(row('anthropic')).toContain('Signed in')
    expect(row('openai')).toContain('Not signed in')
    expect(container.textContent).toContain('phosphor providers login PROVIDER')
    await act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((b) => b.textContent === 'Open machine')
        ?.click(),
    )
    expect(open).toHaveBeenCalledOnce()
    expect(invoke.mock.calls.filter(([channel]) => channel === 'hosts:providers')).toHaveLength(1)
  } finally {
    act(() => root.unmount())
    useMachinesStore.setState({ machines: [] })
    vi.unstubAllGlobals()
  }
})

it('keeps troubleshooting collapsed, orders recovery commands and advances only once online after a beat', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('phosphor', { invoke: vi.fn(async () => []) })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useRemoteLanesStore.setState({ hosts: {} })
  const now = Date.now()
  useMachinesStore.setState({ machines: [MACHINE], nowMs: now, clockOffsetMs: 0 })
  const container = document.createElement('div')
  const root = createRoot(container)
  const next = vi.fn()
  try {
    await act(async () =>
      root.render(
        <OnlineAndProviders
          added={MACHINE}
          providers={false}
          onOpen={() => {}}
          onProviders={next}
        />,
      ),
    )
    expect(container.querySelector('details')?.open).toBe(false)
    expect(container.querySelector('summary')?.textContent).toBe('Stuck?')
    expect([...container.querySelectorAll('code')].map((c) => c.textContent)).toEqual([
      'phosphor setup',
      'phosphor service status',
      'phosphor service install',
      'phosphor run',
    ])
    expect(container.querySelector('button')?.textContent).not.toBe('Continue to Providers')
    await act(async () => vi.advanceTimersByTime(2000))
    expect(next).not.toHaveBeenCalled()
    await act(async () =>
      useMachinesStore.setState({
        machines: [{ ...MACHINE, lastSeenAt: new Date(now).toISOString(), state: 'running' }],
      }),
    )
    await act(async () =>
      useRemoteLanesStore.setState({
        hosts: {
          [MACHINE.id]: {
            connectionToken: 'test-connection',
            state: 'ready',
            capabilities: [],
            repositories: [],
            lanes: [],
          },
        },
      }),
    )
    expect(container.textContent).toContain('bee1 is online')
    await act(async () => vi.advanceTimersByTime(1499))
    expect(next).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTime(1))
    expect(next).toHaveBeenCalledOnce()
  } finally {
    act(() => root.unmount())
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})

it('lists the Host’s own Claude Code provider row when its Claude check cannot be read', async () => {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'hosts:claude') throw new Error('unknown method')
    return channel === 'hosts:providers'
      ? [
          { id: 'pi-claude-cli', name: 'Claude Code', status: 'ready' },
          { id: 'anthropic', name: 'Anthropic', status: 'ready' },
        ]
      : null
  })
  vi.stubGlobal('phosphor', { invoke })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useRemoteLanesStore.setState({ hosts: readyHost(['skills.read']) })
  useMachinesStore.setState({ machines: [MACHINE], nowMs: Date.now(), clockOffsetMs: 0 })
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(
        <OnlineAndProviders added={MACHINE} providers onOpen={() => {}} onProviders={() => {}} />,
      ),
    )
    expect(invoke).toHaveBeenCalledWith('hosts:claude', MACHINE.id)
    expect(container.querySelector('[data-provider=anthropic]')).not.toBeNull()
    expect(container.querySelector('[data-provider=pi-claude-cli]')).not.toBeNull()
    expect(container.querySelector('[data-provider=pi-claude-cli]')?.textContent).toContain(
      'Claude Code',
    )
  } finally {
    act(() => root.unmount())
    useMachinesStore.setState({ machines: [] })
    useRemoteLanesStore.setState({ hosts: {} })
    vi.unstubAllGlobals()
  }
})
