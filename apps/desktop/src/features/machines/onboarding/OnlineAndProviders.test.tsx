// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { OnlineAndProviders } from './OnlineAndProviders'
import { MACHINE } from '../__fixtures__/control'
import { useMachinesStore } from '@/stores/machines'

it('follows directory online state and reads provider readiness without owning sign-in', async () => {
  const invoke = vi.fn(async () => [
    { id: 'anthropic', name: 'Anthropic', status: 'ready' },
    { id: 'openai', name: 'OpenAI', status: 'not_ready' },
  ])
  vi.stubGlobal('phosphor', { invoke })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
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
    expect(container.textContent).toContain('Online. The Host is reporting')
    await act(async () => useMachinesStore.setState({ nowMs: now + 600000 }))
    expect(container.textContent).toContain('Offline. Wake the machine')
    await render(true)
    expect(invoke).toHaveBeenCalledWith('hosts:providers', MACHINE.id)
    expect(container.textContent).toContain('Anthropic: Ready')
    expect(container.textContent).toContain('OpenAI: Sign-in needed')
    expect(container.textContent).toContain('phosphor providers login PROVIDER')
    await act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((b) => b.textContent === 'Open machine Readiness')
        ?.click(),
    )
    expect(open).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledTimes(1)
  } finally {
    act(() => root.unmount())
    useMachinesStore.setState({ machines: [] })
    vi.unstubAllGlobals()
  }
})
