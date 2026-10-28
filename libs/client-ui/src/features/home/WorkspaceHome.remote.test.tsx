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
import { useHomeSubmissionsStore } from '@/stores/homeSubmissions'
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
  useHomeSubmissionsStore.setState({ pending: {} })
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
      return [
        {
          id: 'model',
          provider: 'p',
          name: hostId === other ? 'Other model' : 'Home model',
          reasoning: false,
        },
      ]
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
  'keeps Home catalogue while Skills overlays and submits worktree preference %s',
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
      ...(preferWorktree ? { worktree: { branch: 'phosphor/first-prompt', fresh: true } } : {}),
    })
  },
)

it.each(['none', 'text', 'attachment'] as const)(
  'clears accepted content after persistence debounce, preserving newer edits=%s',
  async (edit) => {
    vi.useFakeTimers()
    useDraftsStore.getState().setText(key, 'First prompt')
    let finish!: (value: unknown) => void
    receipt.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await render()
    const originalAttachments = useDraftsStore.getState().drafts[key]!.attachments
    await send()
    expect(receipt).toHaveBeenCalledOnce()
    await act(async () => vi.advanceTimersByTimeAsync(500))
    expect(invoke).toHaveBeenCalledWith(
      'app:setDraft',
      expect.objectContaining({ key, text: 'First prompt' }),
    )
    expect(useDraftsStore.getState().drafts[key]!.attachments).not.toBe(originalAttachments)
    if (edit === 'text') act(() => useDraftsStore.getState().setText(key, 'Genuinely newer text'))
    if (edit === 'attachment')
      act(() =>
        useDraftsStore
          .getState()
          .setAttachments(key, [{ kind: 'file', name: 'new.txt', path: '/new.txt', size: 3 }]),
      )
    await act(async () => finish({ success: true }))
    expect(useDraftsStore.getState().drafts[key]?.text).toBe(
      edit === 'none' ? undefined : edit === 'text' ? 'Genuinely newer text' : 'First prompt',
    )
  },
)

it('retains the submission claim after adoption unmounts Home and the user returns before receipt', async () => {
  let finish!: (value: unknown) => void
  receipt.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  function NavigatingHome(): React.JSX.Element {
    const active = useSessionsStore((s) => s.activeSessionId)
    return active ? <p>Lane open</p> : <WorkspaceHome workspacePath="/ws" />
  }
  await act(async () => root.render(<NavigatingHome />))
  await send()
  expect(el.textContent).toBe('Lane open')
  await act(async () => useSessionsStore.setState({ activeSessionId: null }))
  await send()
  expect(invoke.mock.calls.filter(([c]) => c === 'hosts:createLane')).toHaveLength(1)
  expect(receipt).toHaveBeenCalledOnce()
  await act(async () => finish({ success: true }))
  expect(useHomeSubmissionsStore.getState().pending[key]).toBeUndefined()
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
  expect(el.textContent).toContain('Connected')
  expect(el.textContent).toContain('Remote demo lane')
  expect(el.textContent).toContain('host-branch')
  expect(el.querySelector('[data-state="unseen"]')).not.toBeNull()
  expect(el.querySelector('[data-segment="time"]')?.textContent).toBe(
    new Date(0).toLocaleDateString(),
  )
  expect(el.querySelector('[data-segment="branch"]')?.textContent).toContain('⎇ host-branch')
  expect(el.querySelector('[data-segment="worktree"]')).toBeNull()
  expect(el.textContent).not.toContain('idle')
  expect(el.textContent).not.toContain('Needs attention')
  expect(el.textContent).not.toContain('Mac-only lane')
  expect(el.querySelector('[data-testid=home-ledger]')).toBeNull()
  expect(el.textContent).not.toContain('Project stats')
  expect(invoke.mock.calls.some(([c]) => c === 'sessions:stats')).toBe(false)
  await act(async () =>
    el.querySelector<HTMLButtonElement>('[aria-label="Remote demo lane"]')!.click(),
  )
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
      state === 'down' ? 'Machine not connected' : 'Not available on remote lanes yet.',
    )
    expect(el.textContent).not.toContain('Mac-only lane')
    expect(el.textContent).not.toContain('Remote demo lane')
    expect(el.querySelector('[data-testid=home-ledger]')).toBeNull()
    expect(invoke.mock.calls.some(([c]) => c === 'sessions:stats')).toBe(false)
  },
)

it('releases a failed submission claim without clearing its draft', async () => {
  receipt.mockResolvedValue({ success: false, error: 'Not accepted' })
  await render()
  await send()
  expect(useDraftsStore.getState().drafts[key]?.text).toBe('First prompt')
  expect(useHomeSubmissionsStore.getState().pending[key]).toBeUndefined()
  expect(el.textContent).toContain('The Host could not confirm this.')
  receipt.mockResolvedValue({ success: true })
  await send()
  expect(invoke.mock.calls.filter(([c]) => c === 'hosts:createLane')).toHaveLength(2)
  expect(useDraftsStore.getState().drafts[key]).toBeUndefined()
})

it.each(['exhausted', 'prefix'] as const)(
  'keeps the draft and explains a %s fresh branch failure',
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
    expect(useDraftsStore.getState().drafts[key]?.text).toBe('First prompt')
    expect(invoke.mock.calls.filter(([channel]) => channel === 'hosts:createLane')).toHaveLength(
      mode === 'prefix' ? 0 : 5,
    )
    expect(el.textContent).toContain(
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
  ['lane-create-failed', `${MOCK_HOST_ID} couldn't start this lane. Nothing was created.`],
  ['lane-limit', `${MOCK_HOST_ID} has reached its lane limit.`],
  ['Lane creation not confirmed.', 'The Host could not confirm this.'],
])('keeps the draft and names a %s creation outcome', async (code, message) => {
  useWorktreesStore.setState({ preferWorktree: false, branchPrefix: 'phosphor/' })
  const original = invoke.getMockImplementation()
  invoke.mockImplementation(async (channel, ...args) => {
    if (channel === 'hosts:createLane') throw new Error(code)
    return original?.(channel, ...args)
  })
  await render()
  await send()
  expect(useDraftsStore.getState().drafts[key]?.text).toBe('First prompt')
  expect(invoke.mock.calls.filter(([channel]) => channel === 'hosts:createLane')).toHaveLength(1)
  expect(el.textContent).toContain(message)
  expect(receipt).not.toHaveBeenCalled()
})
