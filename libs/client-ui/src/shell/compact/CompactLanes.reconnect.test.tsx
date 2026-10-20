// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { CompactLanes } from './CompactLanes'
import { NavigationProvider } from '@/navigation/Navigation'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useMachinesStore } from '@/stores/machines'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { MACHINE } from '@/features/machines/__fixtures__/control'
import type { HostConnectionView } from '@shared/ipc'

/* Unlocking the phone reconnects every Host. The list it left must not blank out meanwhile. */
it('keeps the last-known lanes while a Host reconnects, and only a down Host clears them', async () => {
  const host = mockRemoteHosts[MOCK_HOST_ID]!
  const show = (state: HostConnectionView['state']) =>
    act(async () =>
      useRemoteLanesStore.setState({
        hosts: { [MOCK_HOST_ID]: { ...host, state } },
        snapshotStatus: 'ready',
      }),
    )
  useMachinesStore.setState({
    machines: [{ ...MACHINE, id: MOCK_HOST_ID }],
    loading: false,
    error: null,
  })
  await show('ready')
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  try {
    await act(async () =>
      root.render(
        <NavigationProvider value={{ location: { to: 'lanes' }, navigate: vi.fn() }}>
          <CompactLanes />
        </NavigationProvider>,
      ),
    )
    expect(element.textContent).toContain('Remote demo lane')
    await show('reconnecting')
    expect(element.textContent).toContain('Remote demo lane')
    const status = () => element.querySelector('[role="status"]')
    expect(status()?.textContent).toBe(`Reconnecting to ${MACHINE.label}…`)
    expect(status()?.querySelector('svg.animate-spin')).not.toBeNull()
    expect(element.textContent).not.toContain('Machine not connected')
    await show('connecting')
    expect(status()?.textContent).toBe(`Connecting to ${MACHINE.label}…`)
    await show('down')
    expect(element.textContent).not.toContain('Remote demo lane')
    expect(element.textContent).toContain('Machine not connected')
  } finally {
    await act(async () => root.unmount())
    element.remove()
    useRemoteLanesStore.setState({ hosts: {}, snapshotStatus: 'idle' })
  }
})
