// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ContextMenuHost } from '@/components/ContextMenu'
import { mockRemoteHosts, MOCK_HOST_ID, mockRemoteInfo } from '@/dev/mockRemoteLanes'
import { useChatStore } from '@/stores/chat'
import { usePromptStore } from '@/stores/prompt'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { TopBar } from './TopBar'

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {} }),
  })
})
vi.mock('@/features/workspaces/WorkspaceChip', () => ({ WorkspaceChip: () => null }))
vi.mock('@/features/worktrees/BranchControl', () => ({ BranchControl: () => null }))
vi.mock('@/features/chat/composer/SwarmSwitch', () => ({ SwarmBadge: () => null }))

const SESSION = mockRemoteInfo.sessionId
const piCommand = vi.fn(async () => ({ success: true }))
let root: Root
let container: HTMLDivElement

function controller(self: boolean): void {
  const hosts = structuredClone(mockRemoteHosts)
  hosts[MOCK_HOST_ID]!.lanes[0]!.control.controller = {
    label: self ? 'This Desktop' : 'Another Desktop',
    connected: true,
    self,
  }
  useRemoteLanesStore.setState({ hosts })
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke: vi.fn().mockResolvedValue(undefined), piCommand })
  piCommand.mockClear()
  usePromptStore.setState({ requests: [] })
  useSessionsStore.setState({
    activeSessionId: SESSION,
    live: { [SESSION]: { ...mockRemoteInfo, phosphorId: SESSION } },
  })
  useChatStore.setState({ sessions: {} })
  controller(false)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function render(): void {
  act(() =>
    root.render(
      <>
        <TopBar workspacePath={mockRemoteInfo.workspacePath} />
        <ContextMenuHost />
      </>,
    ),
  )
}
const buttons = (): HTMLButtonElement[] => [...document.querySelectorAll('button')]
const trigger = (): HTMLButtonElement | undefined =>
  buttons().find((b) => b.getAttribute('aria-label') === 'Session options')
const row = (label: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-testid="context-menu"] button')].find(
    (b) => b.textContent?.startsWith(label),
  )

it('shows Session options in the top bar for a Host lane (regression)', () => {
  render()
  expect(trigger()).toBeDefined()
})

it("sends the controller's Compact now to the lane through pi (regression)", async () => {
  controller(true)
  render()
  act(() => trigger()?.click())
  await act(async () => row('Compact now')?.click())
  const request = usePromptStore.getState().requests[0]
  if (request) await act(async () => usePromptStore.getState().dismiss(request, ''))
  expect(piCommand).toHaveBeenCalledWith(SESSION, { type: 'compact' })
})

it('disables the commands for a reader and Export on every Host lane (regression)', () => {
  render()
  act(() => trigger()?.click())
  for (const label of ['Compact now', 'Auto-compaction', 'Auto-retry', 'Steering', 'Follow-ups']) {
    expect(row(label)?.disabled, label).toBe(true)
    expect(row(label)?.textContent, label).toContain('Take control first.')
  }
  expect(row('Export')?.disabled).toBe(true)
  expect(row('Export')?.textContent).toContain('Not available on remote lanes yet.')
  act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
  controller(true)
  render()
  act(() => trigger()?.click())
  expect(row('Auto-retry')?.disabled).toBe(false)
  expect(row('Export')?.disabled).toBe(true)
})
