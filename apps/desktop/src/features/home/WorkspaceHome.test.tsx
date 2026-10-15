// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { WorkspaceHome } from './WorkspaceHome'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useDraftsStore, homeDraftKey } from '@/stores/drafts'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { startChat } from '@/features/sessions/startChat'

vi.mock('@/features/sessions/startChat', () => ({ startChat: vi.fn(), prefetchTrunk: vi.fn() }))
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
vi.mock('@/features/sessions/RemoteLanes', () => ({
  NewRemoteLane: ({ hostId, onClose }: { hostId: string; onClose: () => void }) => (
    <div role="dialog">
      {hostId}
      <button onClick={onClose}>Close</button>
    </div>
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
