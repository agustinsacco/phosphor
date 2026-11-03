// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MOCK_HOST_ID, mockRemoteHosts } from '@/dev/mockRemoteLanes'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { HostGate } from './HostGate'
import { HostSectionProvider } from './HostSection'

const invoke = vi.fn(async (): Promise<unknown> => undefined)
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke, platform: 'darwin' })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('renders signed out, with no clock reading, without an uncached store snapshot (regression R-U7)', async () => {
  // Signed out, the machines store holds no clock reading.
  useMachinesStore.setState({ machines: [], nowMs: 0, clockOffsetMs: 0 })
  useRemoteLanesStore.setState({
    hosts: { [MOCK_HOST_ID]: structuredClone(mockRemoteHosts[MOCK_HOST_ID]!) },
  })
  let tick = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => ++tick)
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  let failure: unknown = null
  try {
    await act(async () =>
      root.render(
        <HostSectionProvider machine={{ id: MOCK_HOST_ID, label: 'Studio' }} section="agent" scoped>
          <HostGate>ready</HostGate>
        </HostSectionProvider>,
      ),
    )
  } catch (error) {
    failure = String(error)
  }
  expect(failure).toBeNull()
  expect(errors.mock.calls.flat().join('\n')).not.toMatch(/getSnapshot should be cached/)
  expect(container.textContent).toContain('Studio')
})
