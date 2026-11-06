// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { useRemoteModel } from './useRemoteModel'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useMachineCataloguesStore } from '@/stores/machineCatalogues'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'

afterEach(() => {
  useRemoteLanesStore.setState({ hosts: {} })
  useMachineCataloguesStore.setState({ catalogues: {} })
  vi.unstubAllGlobals()
})

it('a ready Host without skills.read says it does not offer models', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const invoke = vi.fn(async (_channel: string) => ({}))
  vi.stubGlobal('phosphor', { invoke })
  useRemoteLanesStore.setState({
    hosts: { [MOCK_HOST_ID]: structuredClone(mockRemoteHosts[MOCK_HOST_ID]!) },
  })
  function Hint() {
    return <p>{useRemoteModel(MOCK_HOST_ID).hint}</p>
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => root.render(<Hint />))
  expect(container.textContent).toBe('This Host does not offer models to this device.')
  act(() => root.unmount())
  expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('hosts:models')
})
