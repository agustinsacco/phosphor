// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useRoutineModels } from './useRoutineModels'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useModelCatalogueStore } from '@/stores/modelCatalogue'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
it('uses only Host models for a Host routine, refusing a down Host instead of local catalogue data', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const invoke = vi.fn(async (channel) =>
    channel === 'hosts:skills'
      ? { skills: [], probe: 'rpc', userRoot: 'opaque' }
      : channel === 'hosts:models'
        ? [{ id: 'host-model', name: 'Host model', provider: 'host', reasoning: false }]
        : [{ id: 'host', name: 'Host', status: 'ready' }],
  )
  vi.stubGlobal('phosphor', { invoke })
  const hydrate = vi
    .spyOn(useModelCatalogueStore.getState(), 'hydrate')
    .mockResolvedValue(undefined)
  useModelCatalogueStore.setState({
    models: [{ id: 'local-model', name: 'Mac model', provider: 'mac', reasoning: false }],
  })
  const hosts = structuredClone(mockRemoteHosts)
  hosts[MOCK_HOST_ID]!.capabilities.push('skills.read')
  useRemoteLanesStore.setState({ hosts })
  const container = document.createElement('div'),
    root = createRoot(container)
  function Harness() {
    const catalogue = useRoutineModels(`host:${MOCK_HOST_ID}`)
    return <div>{catalogue.models.map((m) => m.name).join(',')}</div>
  }
  try {
    await act(async () => root.render(<Harness />))
    expect(container.textContent).toBe('Host model')
    expect(hydrate).not.toHaveBeenCalled()
    expect(invoke.mock.calls.map(([c]) => c)).toEqual([
      'hosts:skills',
      'hosts:models',
      'hosts:providers',
    ])
    await act(async () =>
      useRemoteLanesStore.setState({
        hosts: { [MOCK_HOST_ID]: { ...hosts[MOCK_HOST_ID]!, state: 'down' } },
      }),
    )
    expect(container.textContent).toBe('')
  } finally {
    act(() => root.unmount())
    hydrate.mockRestore()
    vi.unstubAllGlobals()
  }
})
