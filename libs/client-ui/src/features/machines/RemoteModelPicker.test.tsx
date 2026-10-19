// @vitest-environment jsdom
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.mock('@/features/chat/composer/ComposerInput', () => ({
  ComposerInput: ({
    onSubmit,
    modelPicker,
  }: {
    onSubmit: () => void
    modelPicker: React.ReactNode
  }) => (
    <div>
      {modelPicker}
      <button aria-label="Start session" onClick={onSubmit}>
        Send
      </button>
    </div>
  ),
}))
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useRemoteModel, RemoteModelPicker } from './RemoteModelPicker'
import { WorkspaceHome } from '@/features/home/WorkspaceHome'
import { useDraftsStore, homeDraftKey } from '@/stores/drafts'
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
    useRemoteLanesStore.setState({ filter: MOCK_HOST_ID })
    useDraftsStore.getState().setText(homeDraftKey('/ws'), 'First message')
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try {
      await act(async () => root.render(<WorkspaceHome workspacePath="/ws" />))
      const create = [...document.querySelectorAll('button')].find(
        (b) => b.getAttribute('aria-label') === 'Start session',
      )!
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
it('uses the Mac thinking default, remembers per Host across remounts, and clamps without writing Mac settings', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const { useRemoteModelPicks } = await import('@/stores/remoteModelPicks')
  const { useMachineCataloguesStore, machineCatalogueKey } =
    await import('@/stores/machineCatalogues')
  useRemoteModelPicks.setState({ last: {}, thinking: {} })
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
  useMachineCataloguesStore.setState({
    catalogues: Object.fromEntries(
      ['a', 'b'].map((id) => [
        machineCatalogueKey(id),
        {
          models: [{ id: 'm', name: 'Reasoner', provider: 'p', reasoning: id === 'a' }],
          providers: [{ id: 'p', name: 'P', status: 'ready' }],
          status: 'ready',
          error: null,
        },
      ]),
    ),
  })
  Element.prototype.scrollIntoView = vi.fn()
  const invoke = vi.fn(async (_channel: string) => ({
    defaultThinkingLevel: 'high',
    defaultProvider: 'p',
    defaultModel: 'desktop',
  }))
  vi.stubGlobal('phosphor', { invoke })
  function Harness({ id }: { id: string }) {
    const selection = useRemoteModel(id)
    return (
      <div>
        <output>{selection.thinking}</output>
        <RemoteModelPicker selection={selection} />
      </div>
    )
  }
  const catalogue = useMachineCataloguesStore.getState().catalogues[machineCatalogueKey('a')]!
  catalogue.models.unshift({ id: 'desktop', name: 'Desktop', provider: 'p', reasoning: false })
  useRemoteModelPicks.setState({ last: { a: { id: 'm', provider: 'p' } } })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<Harness id="a" />))
    expect(container.querySelector('[aria-label=Model]')?.textContent).toBe('Reasoner')
    expect(container.querySelector('[aria-label=Thinking]')?.textContent).toBe('high')
    act(() => container.querySelector<HTMLButtonElement>('[aria-label=Thinking]')!.click())
    act(() =>
      [...document.querySelectorAll<HTMLButtonElement>('[role=option]')]
        .find((b) => b.textContent === 'low')!
        .click(),
    )
    await act(async () => root.render(<Harness id="b" />))
    expect(container.querySelector('output')?.textContent).toBe('off')
    expect(container.querySelector('[aria-label=Thinking]')).toBeNull()
    await act(async () => root.render(null))
    await act(async () => root.render(<Harness id="a" />))
    expect(container.querySelector('[aria-label=Thinking]')?.textContent).toBe('low')
    expect(useRemoteModelPicks.getState().thinking).toEqual({ a: 'low' })
    expect(invoke.mock.calls.every((args) => args[0] !== 'pi:patchAgentSettings')).toBe(true)
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})
