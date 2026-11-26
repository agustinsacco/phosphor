// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { WorkspaceHome } from './WorkspaceHome'
import { SkillsPage } from '@/features/skills/SkillsPage'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { usePullRequestsStore } from '@/stores/pullRequests'
import { useMachinePagesStore } from '@/stores/machinePages'
import { useMachineCataloguesStore } from '@/stores/machineCatalogues'
import { useLaneCreatesStore } from '@/stores/laneCreates'
import { hostResourceKey } from '@shared/remote-host'
import { useWorktreesStore } from '@/stores/worktrees'
import { useDraftsStore, homeDraftKey } from '@/stores/drafts'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import type * as StartChatModule from '@/features/sessions/startChat'
import type { WorkspaceSessionStats, SessionMeta } from '@shared/models'

vi.mock('@/features/sessions/startChat', async (original) => ({
  ...(await original<typeof StartChatModule>()),
  startChat: vi.fn(),
  prefetchTrunk: vi.fn(),
}))
vi.mock('./HomeModelPicker', () => ({ HomeModelPicker: () => null }))
vi.mock('@/features/workspaces/WorkspaceChip', () => ({ WorkspaceChip: () => null }))
vi.mock('@/features/worktrees/BranchControl', () => ({ BranchControl: () => null }))
vi.mock('@/features/chat/composer/ContextSourcesMenu', () => ({ ContextSourcesMenu: () => null }))
vi.mock('@/features/chat/composer/useSlashMenu', () => ({ useSlashMenu: () => ({}) }))
vi.mock('@/components/markdown/Markdown', () => ({ Markdown: () => null }))
vi.mock('@/features/chat/composer/ComposerInput', () => ({
  ComposerInput: ({
    onSubmit,
    modelPicker,
  }: {
    onSubmit: () => void
    modelPicker: React.ReactNode
  }) => (
    <div data-testid="home-composer">
      {modelPicker}
      <button onClick={onSubmit}>Send draft</button>
    </div>
  ),
}))
const key = homeDraftKey('/ws')
const placeholder = () => Object.values(useLaneCreatesStore.getState().creates)[0]
const other = 'other-host'
let root: Root
let el: HTMLDivElement
type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>
let invoke: ReturnType<typeof vi.fn<Invoke>>
let receipt: ReturnType<typeof vi.fn>
const stats = {
  sessionCount: 1,
  messages: 4,
  tokens: 200,
  cost: 12,
  savedTokens: 0,
  activeDays: 1,
  activityByDay: {},
} as WorkspaceSessionStats
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  host.capabilities.push('skills.read')
  host.lanes = [{ ...host.lanes[0]!, branch: 'host-branch' }]
  host.lanes[0]!.control.controller = { self: true, connected: true, label: 'Desktop' }
  useRemoteLanesStore.setState({
    filter: MOCK_HOST_ID,
    hosts: { [MOCK_HOST_ID]: host, [other]: structuredClone(host) },
    error: null,
  })
  useSessionsStore.setState({
    activeSessionId: null,
    live: {},
    gitByCwd: {},
    disk: {
      '/ws': [
        {
          path: '/local',
          cwd: '/ws',
          name: 'Mac-only lane',
          lastActivityAt: '',
          mtimeMs: 0,
          cost: 12,
        } as SessionMeta,
      ],
    },
  })
  useMachineCataloguesStore.setState({ catalogues: {} })
  useLaneCreatesStore.setState({ creates: {} })
  useMachinePagesStore.setState({ skillsMachine: null })
  useDraftsStore.setState({ drafts: {}, revisions: {} })
  useDraftsStore.getState().setText(key, 'First prompt')
  vi.spyOn(usePullRequestsStore.getState(), 'refresh').mockResolvedValue()
  vi.spyOn(useSessionsStore.getState(), 'activate').mockImplementation((id) =>
    useSessionsStore.setState({ activeSessionId: id }),
  )
  vi.spyOn(useSessionsStore.getState(), 'adoptSession').mockImplementation(
    async (id, workspacePath, _disk, info) => {
      useSessionsStore.setState((s) => ({
        live: { ...s.live, [id]: { ...info, phosphorId: id, workspacePath } },
      }))
    },
  )
  receipt = vi.fn().mockResolvedValue({ success: true })
  invoke = vi.fn<Invoke>().mockImplementation(async (channel, hostId) => {
    if (channel === 'hosts:skills') return { skills: [], probe: 'rpc', userRoot: 'opaque' }
    if (channel === 'hosts:models')
      return {
        models: [
          {
            id: 'model',
            provider: 'p',
            name: hostId === other ? 'Other model' : 'Home model',
            reasoning: false,
          },
        ],
      }
    if (channel === 'hosts:providers') return [{ id: 'p', name: 'Provider', status: 'ready' }]
    if (channel === 'pi:agentSettings') return {}
    if (channel === 'hosts:snapshot') return useRemoteLanesStore.getState().hosts
    if (channel === 'hosts:createLane' || channel === 'hosts:openLane') return mockRemoteInfo
    if (channel === 'sessions:stats') return stats
    if (channel === 'git:info') return { isRepo: false }
    if (channel === 'app:userInfo') return { username: 'test' }
    return null
  })
  Object.defineProperty(window, 'phosphor', {
    configurable: true,
    value: { invoke, piCommand: receipt },
  })
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  useDraftsStore.getState().clear(key)
  vi.useRealTimers()
  vi.restoreAllMocks()
})
async function render(skills = false): Promise<void> {
  await act(async () =>
    root.render(
      <>
        <WorkspaceHome workspacePath="/ws" />
        {skills && <SkillsPage workspacePath="/ws" />}
      </>,
    ),
  )
}
async function send(): Promise<void> {
  await act(async () =>
    [...el.querySelectorAll('button')].find((b) => b.textContent === 'Send draft')!.click(),
  )
}
const model = () => el.querySelector('[data-testid=home-composer]')?.textContent

it.each([true, false])(
  'keeps Home catalogue while Skills overlays and submits a worktree whatever the local preference (%s)',
  async (preferWorktree) => {
    useWorktreesStore.setState({ preferWorktree, branchPrefix: 'phosphor/' })
    await render()
    expect(model()).toContain('Home model')
    await render(true)
    expect(model()).toContain('Home model')
    await act(async () => useMachinePagesStore.setState({ skillsMachine: other }))
    expect(el.textContent).toContain('Other model')
    expect(model()).toContain('Home model')
    await render(false)
    expect(model()).toContain('Home model')
    await send()
    expect(invoke).toHaveBeenCalledWith('hosts:createLane', MOCK_HOST_ID, {
      repositoryId: '0000000000000001',
      model: 'model',
      provider: 'p',
      thinkingLevel: 'off',
      worktree: { branch: 'phosphor/first-prompt', fresh: true },
    })
  },
)

it.each([false, true, undefined])(
  'asks a Host for a worktree unless git is known absent, then says so (git=%s)',
  async (git) => {
    useWorktreesStore.setState({ preferWorktree: true, branchPrefix: 'phosphor/' })
    const host = useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]!
    const repository = { ...host.repositories[0]!, ...(git === undefined ? {} : { git }) }
    useRemoteLanesStore.setState({
      hosts: {
        ...useRemoteLanesStore.getState().hosts,
        [MOCK_HOST_ID]: { ...host, repositories: [repository] },
      },
    })
    await render()
    expect(el.querySelector('input[type=checkbox]')).toBeNull()
    expect(el.textContent?.includes('no git · runs in folder')).toBe(git === false)
    await send()
    expect(invoke).toHaveBeenCalledWith('hosts:createLane', MOCK_HOST_ID, {
      repositoryId: repository.id,
      model: 'model',
      provider: 'p',
      thinkingLevel: 'off',
      ...(git === false ? {} : { worktree: { branch: 'phosphor/first-prompt', fresh: true } }),
    })
    expect(useWorktreesStore.getState().preferWorktree).toBe(true)
  },
)

it.each([true, false])(
  'offers `/` on a Host that can list its commands, as This Mac does (skills.read=%s)',
  async (canRead) => {
    useDraftsStore.getState().setText(key, '')
    const host = useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]!
    if (!canRead)
      useRemoteLanesStore.setState({
        hosts: {
          ...useRemoteLanesStore.getState().hosts,
          [MOCK_HOST_ID]: {
            ...host,
            capabilities: host.capabilities.filter((c) => c !== 'skills.read'),
          },
        },
      })
    await render()
    expect(el.textContent?.includes('/ commands')).toBe(canRead)
  },
)

it.each(['none', 'text', 'attachment'] as const)(
  'clears the composer at Enter and never touches a newer edit when the lane lands, edit=%s',
  async (edit) => {
    let finish!: (value: unknown) => void
    receipt.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await render()
    await send()
    expect(useDraftsStore.getState().drafts[key]?.text ?? '').toBe('')
    expect(placeholder()?.text).toBe('First prompt')
    if (edit === 'text') act(() => useDraftsStore.getState().setText(key, 'Genuinely newer text'))
    if (edit === 'attachment')
      act(() =>
        useDraftsStore
          .getState()
          .setAttachments(key, [{ kind: 'file', name: 'new.txt', path: '/new.txt', size: 3 }]),
      )
    await vi.waitFor(() => expect(receipt).toHaveBeenCalledOnce())
    await act(async () => finish({ success: true }))
    expect(useDraftsStore.getState().drafts[key]?.text ?? '').toBe(
      edit === 'text' ? 'Genuinely newer text' : '',
    )
    expect(placeholder()).toBeUndefined()
  },
)

it('runs a slow create behind its placeholder and sends one first prompt when it lands', async () => {
  vi.useFakeTimers()
  const fallback = invoke.getMockImplementation()!
  invoke.mockImplementation(async (channel, ...args) => {
    if (channel === 'hosts:createLane') {
      await new Promise((resolve) => setTimeout(resolve, 75_000))
      return mockRemoteInfo
    }
    return fallback(channel, ...args)
  })
  function NavigatingHome(): React.JSX.Element {
    const active = useSessionsStore((s) => s.activeSessionId)
    return active ? <p>Lane open</p> : <WorkspaceHome workspacePath="/ws" />
  }
  await act(async () => root.render(<NavigatingHome />))
  await send()
  // At once: the placeholder is the screen and the composer is empty.
  expect(useSessionsStore.getState().opening?.create).toBe(placeholder()?.id)
  expect(useDraftsStore.getState().drafts[key]?.text ?? '').toBe('')
  await act(async () => vi.advanceTimersByTimeAsync(74_999))
  expect(receipt).not.toHaveBeenCalled()
  await act(async () => vi.advanceTimersByTimeAsync(1))
  expect(invoke.mock.calls.filter(([c]) => c === 'hosts:createLane')).toHaveLength(1)
  expect(receipt).toHaveBeenCalledExactlyOnceWith(mockRemoteInfo.sessionId, {
    type: 'prompt',
    message: 'First prompt',
    images: [],
  })
  expect(el.textContent).toBe('Lane open')
  expect(placeholder()).toBeUndefined()
})

it('renders This Mac -> Host -> This Mac dashboards without leaking lanes, ledger or stats', async () => {
  useRemoteLanesStore.setState({ filter: 'local' })
  await render()
  expect(el.textContent).toContain('Mac-only lane')
  expect(el.querySelector('[data-testid=home-ledger]')).not.toBeNull()
  expect(el.textContent).toContain('Project stats')
  invoke.mockClear()
  await act(async () => useRemoteLanesStore.getState().setFilter(MOCK_HOST_ID))
  expect(el.querySelector('[aria-label="Host home"]')).not.toBeNull()
  // Host home is the Host's orbit: one dot per Host lane, none of This Mac's.
  const dot = el.querySelector<HTMLButtonElement>(`[data-lane-id="${mockRemoteInfo.laneId}"]`)
  expect(dot?.getAttribute('aria-label')).toBe(
    `Remote demo lane, New activity · ${new Date(0).toLocaleDateString()}`,
  )
  expect(dot?.dataset.tone).toBe('unread')
  expect(el.querySelectorAll('.host-orbit-dot')).toHaveLength(1)
  expect(el.textContent).not.toContain('idle')
  expect(el.textContent).not.toContain('Needs attention')
  expect(el.textContent).not.toContain('Mac-only lane')
  expect(el.querySelector('[data-testid=home-ledger]')).toBeNull()
  expect(el.textContent).not.toContain('Project stats')
  expect(invoke.mock.calls.some(([c]) => c === 'sessions:stats')).toBe(false)
  await act(async () => dot!.click())
  expect(invoke).toHaveBeenCalledWith('hosts:openLane', MOCK_HOST_ID, mockRemoteInfo.laneId)
  await act(async () => useRemoteLanesStore.getState().setFilter('local'))
  expect(el.textContent).toContain('Mac-only lane')
  expect(el.querySelector('[data-testid=home-ledger]')).not.toBeNull()
  expect(el.textContent).not.toContain('Remote demo lane')
})

it.each(['down', 'capability'] as const)(
  'refuses a %s Host dashboard without local data',
  async (state) => {
    useRemoteLanesStore.setState((s) => ({
      hosts: {
        ...s.hosts,
        [MOCK_HOST_ID]: {
          ...s.hosts[MOCK_HOST_ID]!,
          ...(state === 'down' ? { state: 'down' as const } : { capabilities: [] }),
        },
      },
    }))
    await render()
    expect(el.textContent).toContain(
      state === 'down' ? 'Machine not connected' : 'This Host does not offer lanes to this device.',
    )
    expect(el.textContent).not.toContain('Mac-only lane')
    expect(el.textContent).not.toContain('Remote demo lane')
    expect(el.querySelector('[data-testid=home-ledger]')).toBeNull()
    expect(invoke.mock.calls.some(([c]) => c === 'sessions:stats')).toBe(false)
  },
)

it('files the text on the new lane when only its first prompt fails', async () => {
  receipt.mockResolvedValue({ success: false, error: 'Not accepted' })
  await render()
  await send()
  const laneDraft = hostResourceKey(
    { kind: 'remote', hostId: MOCK_HOST_ID },
    'session',
    mockRemoteInfo.laneId!,
  )
  await vi.waitFor(() => expect(placeholder()).toBeUndefined())
  expect(useDraftsStore.getState().drafts[laneDraft]?.text).toBe('First prompt')
  expect(useDraftsStore.getState().drafts[key]?.text ?? '').toBe('')
  expect(invoke.mock.calls.filter(([c]) => c === 'hosts:createLane')).toHaveLength(1)
})

it.each(['exhausted', 'prefix'] as const)(
  'keeps the text on the placeholder and explains a %s fresh branch failure',
  async (mode) => {
    useWorktreesStore.setState({
      preferWorktree: true,
      branchPrefix: mode === 'prefix' ? 'p'.repeat(99) : 'phosphor/',
    })
    const original = invoke.getMockImplementation()
    invoke.mockImplementation(async (channel, ...args) => {
      if (channel === 'hosts:createLane') throw new Error('branch-exists')
      return original?.(channel, ...args)
    })
    await render()
    await send()
    await vi.waitFor(() => expect(placeholder()?.failure).toBeDefined())
    expect(placeholder()?.text).toBe('First prompt')
    expect(invoke.mock.calls.filter(([channel]) => channel === 'hosts:createLane')).toHaveLength(
      mode === 'prefix' ? 0 : 5,
    )
    expect(placeholder()?.failure).toContain(
      mode === 'prefix'
        ? 'Branch prefix is too long for a Host worktree.'
        : `Couldn't find a free branch name on ${MOCK_HOST_ID}.`,
    )
    expect(receipt).not.toHaveBeenCalled()
  },
)

// A Host that answered "failed" was shown as "could not confirm", which sent people
// checking for a lane that was never created.
it.each([
  ['lane-create-failed', `${MOCK_HOST_ID} couldn't start this lane.`],
  [
    'Git took too long to create the worktree',
    'Git took too long to create the worktree. Your draft is kept.',
  ],
  ['lane-limit', `${MOCK_HOST_ID} is at its lane limit or too busy.`],
])('keeps the text on the placeholder and names a %s creation outcome', async (code, message) => {
  useWorktreesStore.setState({ preferWorktree: false, branchPrefix: 'phosphor/' })
  const original = invoke.getMockImplementation()
  invoke.mockImplementation(async (channel, ...args) => {
    if (channel === 'hosts:createLane') throw new Error(code)
    return original?.(channel, ...args)
  })
  await render()
  await send()
  await vi.waitFor(() => expect(placeholder()?.failure).toBeDefined())
  expect(placeholder()?.text).toBe('First prompt')
  expect(invoke.mock.calls.filter(([channel]) => channel === 'hosts:createLane')).toHaveLength(1)
  expect(placeholder()?.failure).toContain(message)
  expect(receipt).not.toHaveBeenCalled()
})

it('an unconfirmed creation keeps checking with the Host instead of failing', async () => {
  const original = invoke.getMockImplementation()
  invoke.mockImplementation(async (channel, ...args) => {
    if (channel === 'hosts:createLane') throw new Error('Lane creation not confirmed.')
    return original?.(channel, ...args)
  })
  await render()
  await send()
  await vi.waitFor(() => expect(placeholder()?.checking).toBe(true))
  expect(placeholder()?.failure).toBeUndefined()
  expect(invoke.mock.calls.filter(([channel]) => channel === 'hosts:createLane')).toHaveLength(1)
})

it('keeps a Host home reachable while This Mac’s home shows its setup', async () => {
  const setup = <p>This Mac setup</p>
  await act(async () => root.render(<WorkspaceHome workspacePath="" localSetup={setup} />))
  expect(el.querySelector('[data-testid=home-composer]')).not.toBeNull()
  expect(el.textContent).not.toContain('This Mac setup')
  await act(async () => useRemoteLanesStore.setState({ filter: 'local' }))
  expect(el.textContent).toContain('This Mac setup')
  expect(el.querySelector('[data-testid=home-composer]')).toBeNull()
  expect(invoke).not.toHaveBeenCalledWith('sessions:stats', '')
  await act(async () => useRemoteLanesStore.setState({ filter: MOCK_HOST_ID }))
  expect(el.querySelector('[data-testid=home-composer]')).not.toBeNull()
})

it('can start in the checkout through the service without an in-app probe', async () => {
  useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]!.local = true
  useWorktreesStore.setState({ preferWorktree: false })
  await render()
  expect(el.querySelector('input[type=checkbox]')).not.toBeNull()
  await send()
  const created = invoke.mock.calls.find(([ch]) => ch === 'hosts:createLane')
  expect(created?.[1]).toBe(MOCK_HOST_ID)
  expect(created?.[2]).not.toHaveProperty('worktree')
  expect(invoke.mock.calls.some(([ch]) => ch === 'pi:commands')).toBe(false)
})

it('shows the same-machine branch control only in the Desktop service composer', async () => {
  const { PlatformProvider, WIDE_BROWSER_PLATFORM, COMPACT_PLATFORM, DESKTOP_PLATFORM } =
    await import('@/platform/Platform')
  useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]!.local = true
  for (const platform of [WIDE_BROWSER_PLATFORM, COMPACT_PLATFORM, DESKTOP_PLATFORM]) {
    await act(async () =>
      root.render(
        <PlatformProvider value={platform}>
          <WorkspaceHome workspacePath="/ws" />
        </PlatformProvider>,
      ),
    )
    expect(el.querySelector('input[type=checkbox]') !== null).toBe(platform === DESKTOP_PLATFORM)
  }
})
