// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { WorkspaceHome } from './WorkspaceHome'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useDraftsStore, homeDraftKey } from '@/stores/drafts'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useWorktreesStore } from '@/stores/worktrees'
import { useRemoteComposer, openRemoteComposer, rememberRemoteRepository } from './remoteComposer'
import { useMachinesStore } from '@/stores/machines'
import { startRemoteChat } from './startRemoteChat'
import { useMachineCataloguesStore, machineCatalogueKey } from '@/stores/machineCatalogues'
import { startChat } from '@/features/sessions/startChat'

vi.mock('./startRemoteChat', () => ({ startRemoteChat: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/features/sessions/startChat', () => ({
  startChat: vi.fn(),
  prefetchTrunk: vi.fn(),
  newChatBranchName: vi.fn(() => ({ branch: 'phosphor/keep-my-draft' })),
}))
vi.mock('./LaneBoard', () => ({
  LaneBoard: () => null,
  useLaneBoard: () => ({ board: { lanes: [] }, lanes: [] }),
}))
vi.mock('./laneState', () => ({ boardHeadline: () => null }))
vi.mock('./Ledger', () => ({ Ledger: () => null }))
vi.mock('./HomeModelPicker', () => ({ HomeModelPicker: () => null }))
vi.mock('@/features/workspaces/WorkspaceChip', () => ({ WorkspaceChip: () => null }))
vi.mock('@/features/worktrees/BranchControl', () => ({ BranchControl: () => null }))
vi.mock('@/features/chat/composer/ContextSourcesMenu', () => ({ ContextSourcesMenu: () => null }))
vi.mock('@/features/chat/composer/useSlashMenu', () => ({ useSlashMenu: () => ({}) }))
vi.mock('@/features/chat/composer/ComposerInput', () => ({
  ComposerInput: ({ onSubmit }: { onSubmit: () => void }) => (
    <button onClick={onSubmit}>Send draft</button>
  ),
}))
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  Object.defineProperty(window, 'phosphor', {
    configurable: true,
    value: {
      invoke: vi
        .fn()
        .mockImplementation(async (channel) =>
          channel === 'app:userInfo' ? { username: 'test' } : null,
        ),
    },
  })
  useRemoteComposer.setState({ target: null })
  vi.mocked(startRemoteChat).mockClear()
  useRemoteLanesStore.setState({ filter: 'host-a', hosts: {} })
  useDraftsStore.getState().setText(homeDraftKey('/ws'), 'Keep my draft')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})
function click(text: string): void {
  const button = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(text),
  )!
  act(() => button.click())
}
it('composer follows switcher, allows override, resets on switcher change and never falls back when unavailable', async () => {
  await act(async () => root.render(<WorkspaceHome workspacePath="/ws" />))
  expect(container.querySelector('[aria-label=Machine]')?.textContent).toContain('host-a')
  act(() => container.querySelector<HTMLButtonElement>('[aria-label=Machine]')!.click())
  click('This Mac')
  expect(container.querySelector('[aria-label=Machine]')?.textContent).toContain('This Mac')
  act(() => openRemoteComposer('host-a', 'repo-a'))
  expect(container.querySelector('[aria-label=Machine]')?.textContent).toContain('host-a')
  act(() => useRemoteLanesStore.getState().setFilter('host-b'))
  expect(container.querySelector('[aria-label=Machine]')?.textContent).toContain('host-b')
  expect(container.querySelector('[aria-label=Machine]')?.textContent).toContain('unavailable')
  click('Send draft')
  expect(container.textContent).toContain('Machine not connected')
  expect(startChat).not.toHaveBeenCalled()
  expect(useDraftsStore.getState().drafts[homeDraftKey('/ws')]?.text).toBe('Keep my draft')
  expect(container.querySelector('[aria-label=Machine]')?.textContent).toContain('host-b')
  act(() => useRemoteLanesStore.getState().setFilter('all'))
  expect(container.querySelector('[aria-label=Machine]')?.textContent).toContain('This Mac')
})

it('down and capability-lost composer targets stay remote on submit', async () => {
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  useRemoteLanesStore.setState({ filter: MOCK_HOST_ID, hosts: { [MOCK_HOST_ID]: host } })
  await act(async () => root.render(<WorkspaceHome workspacePath="/ws" />))
  act(() => useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: { ...host, state: 'down' } } }))
  expect(container.querySelector('[aria-label=Machine]')?.textContent).toContain('not connected')
  click('Send draft')
  expect(container.textContent).toContain('Machine not connected')
  act(() =>
    useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: { ...host, capabilities: [] } } }),
  )
  expect(container.querySelector('[aria-label=Machine]')?.textContent).toContain('unavailable')
  click('Send draft')
  expect(container.textContent).toContain('Not available on remote lanes yet.')
  expect(startChat).not.toHaveBeenCalled()
  expect(useDraftsStore.getState().drafts[homeDraftKey('/ws')]?.text).toBe('Keep my draft')
})

it.each([true, false])(
  'repository plus opens the composer and applies worktree preference %s at send',
  async (isolate) => {
    const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
    host.capabilities.push('skills.read')
    host.repositories.push({ id: 'second', name: 'Second repository', path: '/not-local' })
    useMachinesStore.setState({ remoteEnabled: true })
    useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host }, filter: 'local' })
    useWorktreesStore.setState({ preferWorktree: isolate })
    useMachineCataloguesStore.setState({
      catalogues: {
        [machineCatalogueKey(MOCK_HOST_ID)]: {
          status: 'ready',
          error: null,
          models: [{ id: 'm', name: 'Remembered', provider: 'p', reasoning: true }],
          providers: [{ id: 'p', name: 'P', status: 'ready' }],
        },
      },
    })
    act(() => openRemoteComposer(MOCK_HOST_ID, 'second'))
    await act(async () => root.render(<WorkspaceHome workspacePath="/ws" />))
    expect(container.querySelector('[aria-label=Machine]')?.textContent).toContain(MOCK_HOST_ID)
    expect(container.querySelector('[aria-label=Repository]')?.textContent).toContain(
      'Second repository',
    )
    expect(startRemoteChat).not.toHaveBeenCalled()
    await act(async () => click('Send draft'))
    expect(startRemoteChat).toHaveBeenCalledWith(
      MOCK_HOST_ID,
      {
        repositoryId: 'second',
        provider: 'p',
        model: 'm',
        thinkingLevel: 'off',
        ...(isolate ? { worktree: { branch: 'phosphor/keep-my-draft', fresh: true } } : {}),
      },
      'Keep my draft',
      [],
      expect.any(Function),
    )
    act(() => useMachinesStore.setState({ remoteEnabled: false }))
    expect(useRemoteComposer.getState().target).toBeNull()
  },
)

it('switcher navigation clears a previous repository target', () => {
  useMachinesStore.setState({ remoteEnabled: true })
  act(() => openRemoteComposer('host-a', 'repo-a'))
  act(() => useRemoteLanesStore.getState().setFilter('host-b'))
  expect(useRemoteComposer.getState().target).toBeNull()
})

it('New remembers an existing Host repository and falls back when it was removed', () => {
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  host.repositories.push({ id: 'second', name: 'Second', path: '/remote' })
  useMachinesStore.setState({ remoteEnabled: true })
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host } })
  rememberRemoteRepository(MOCK_HOST_ID, 'second')
  openRemoteComposer(MOCK_HOST_ID)
  expect(useRemoteComposer.getState().target?.repositoryId).toBe('second')
  rememberRemoteRepository(MOCK_HOST_ID, 'removed')
  openRemoteComposer(MOCK_HOST_ID)
  expect(useRemoteComposer.getState().target?.repositoryId).toBe(host.repositories[0]?.id)
  for (let i = 0; i < 65; i++) rememberRemoteRepository(`host-${i}`, 'repo')
  expect(Object.keys(useRemoteComposer.getState().repositories)).toHaveLength(64)
  useMachinesStore.setState({ remoteEnabled: false })
  expect(useRemoteComposer.getState().repositories).toEqual({})
})
