// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useRemoteModel, RemoteModelPicker } from './RemoteModelPicker'
import { NewRemoteLane } from '@/features/sessions/RemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useMachinesStore } from '@/stores/machines'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
it.each(['ready', 'down'] as const)(
  'no usable model refuses creation with an honest %s hint',
  async (state) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const invoke = vi.fn(async (channel) =>
      channel === 'hosts:skills'
        ? { skills: [], probe: 'rpc', userRoot: 'opaque' }
        : channel === 'hosts:models'
          ? [{ id: 'm', name: 'Unavailable model', provider: 'p', reasoning: false }]
          : channel === 'hosts:providers'
            ? [{ id: 'p', name: 'Provider', status: 'not_ready' }]
            : {},
    )
    vi.stubGlobal('phosphor', { invoke })
    const hosts = structuredClone(mockRemoteHosts)
    hosts[MOCK_HOST_ID]!.state = state
    hosts[MOCK_HOST_ID]!.capabilities.push('skills.read')
    useRemoteLanesStore.setState({ hosts })
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try {
      await act(async () =>
        root.render(
          <NewRemoteLane hostId={MOCK_HOST_ID} onMachine={() => {}} onClose={() => {}} />,
        ),
      )
      const create = [...document.querySelectorAll('button')].find(
        (b) => b.textContent === 'Create lane',
      )!
      expect(create.disabled).toBe(true)
      await act(async () => create.click())
      expect(invoke.mock.calls.some(([channel]) => channel === 'hosts:createLane')).toBe(false)
      if (state === 'ready') {
        expect(document.body.textContent).toContain(`No signed-in model on ${MOCK_HOST_ID}.`)
        expect(document.body.textContent).not.toContain('Machine not connected')
        const signIn = [...document.querySelectorAll('button')].find(
          (b) => b.textContent === `Sign in on ${MOCK_HOST_ID}`,
        )!
        act(() => signIn.click())
        expect(useMachinesStore.getState().view).toEqual({ kind: 'machine', id: MOCK_HOST_ID })
      } else {
        expect(document.body.textContent).toContain('Machine not connected. Wait for reconnection.')
        expect(document.body.textContent).not.toContain('No signed-in model')
      }
    } finally {
      act(() => root.unmount())
      container.remove()
      vi.unstubAllGlobals()
    }
  },
)

it.each([
  ['a', 'b', 'a'],
  ['b', 'a', 'b'],
])('Host composer model and thinking catalogue refreshes across %j', async (...sequence) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const invoke = vi.fn(async (channel, host) =>
    channel === 'hosts:skills'
      ? { skills: [], probe: 'rpc', userRoot: 'opaque' }
      : channel === 'hosts:models'
        ? [
            {
              id: `model-${host}`,
              name: `Model for ${host}`,
              provider: 'p',
              reasoning: host === 'a',
            },
          ]
        : channel === 'hosts:providers'
          ? [{ id: 'p', name: 'Provider', status: 'ready' }]
          : {},
  )
  vi.stubGlobal('phosphor', { invoke })
  const base = {
    ...mockRemoteHosts[MOCK_HOST_ID]!,
    capabilities: ['skills.read', 'sessions.control'] as const,
  }
  useRemoteLanesStore.setState({
    hosts: {
      a: { ...base, capabilities: [...base.capabilities] },
      b: { ...base, capabilities: [...base.capabilities] },
    },
  })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  function Harness({ id }: { id: string }) {
    const selection = useRemoteModel(id)
    return <RemoteModelPicker selection={selection} />
  }
  try {
    for (const id of sequence) {
      await act(async () => root.render(<Harness id={id} />))
      expect(container.textContent).toContain(`Model for ${id}`)
      expect(container.textContent).not.toContain(`Model for ${id === 'a' ? 'b' : 'a'}`)
      expect(container.querySelector('[aria-label=Thinking]') !== null).toBe(id === 'a')
    }
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})
