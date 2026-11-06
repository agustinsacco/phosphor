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

it('a Host whose model read fails says the models could not be read', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'hosts:skills') return { skills: [], probe: 'rpc', userRoot: 'opaque' }
    throw new Error('Connection closed.')
  })
  vi.stubGlobal('phosphor', { invoke })
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  host.capabilities.push('skills.read')
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host } })
  function Hint() {
    return <p>{useRemoteModel(MOCK_HOST_ID).hint}</p>
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => root.render(<Hint />))
  expect(container.textContent).toBe('Could not read models.')
  act(() => root.unmount())
})

it('a Host whose models have not been read yet says they are loading, not that a read failed', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke: vi.fn(() => new Promise(() => {})) })
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  host.capabilities.push('skills.read')
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host } })
  const hints: string[] = []
  function Hint() {
    const { hint } = useRemoteModel(MOCK_HOST_ID)
    hints.push(hint)
    return <p>{hint}</p>
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => root.render(<Hint />))
  expect(new Set(hints)).toEqual(new Set(['Loading models…']))
  act(() => root.unmount())
})
