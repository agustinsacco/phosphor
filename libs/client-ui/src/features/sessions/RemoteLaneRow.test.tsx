import { usePullRequestsStore } from '@/stores/pullRequests'
import { remotePrKey } from '@shared/host-protocol-github'
import { useExtensionUiStore } from '@/stores/extensionUi'
// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { RemoteLaneRow, remoteLaneTitle } from './RemoteLaneRow'
import { ONLY_WHILE_RUNNING, remoteControlHint, TAKE_CONTROL_FIRST } from './remoteLaneActions'
import { ContextMenuHost } from '@/components/ContextMenu'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { REMOTE_NOT_READY, REMOTE_UNAVAILABLE, useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useChatStore } from '@/stores/chat'
import { NavigationProvider } from '@/navigation/Navigation'
let root: Root, container: HTMLDivElement
const invoke = vi.fn(),
  command = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke, piCommand: command })
  invoke.mockReset().mockResolvedValue({ branchKept: false })
  command.mockReset().mockResolvedValue({ success: true })
  const hosts = structuredClone(mockRemoteHosts)
  hosts[MOCK_HOST_ID]!.capabilities.push('workspaces.write')
  hosts[MOCK_HOST_ID]!.lanes[0]!.control.controller = { self: true, label: 'You', connected: true }
  useRemoteLanesStore.setState({ hosts })
  useSessionsStore.setState({
    live: {
      [mockRemoteInfo.sessionId]: { ...mockRemoteInfo, phosphorId: mockRemoteInfo.sessionId },
    },
    activeSessionId: mockRemoteInfo.sessionId,
  })
  useChatStore.getState().ensure(mockRemoteInfo.sessionId)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
function render(ready = true): void {
  act(() =>
    root.render(
      <>
        <RemoteLaneRow
          hostId={MOCK_HOST_ID}
          lane={useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]!.lanes[0]!}
          ready={ready}
          active
        />
        <ContextMenuHost />
      </>,
    ),
  )
}
function menu(): void {
  act(() =>
    container
      .querySelector('button')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })),
  )
}
function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) =>
    b.textContent?.trim().startsWith(text),
  )
  if (!found) throw new Error(text)
  return found
}
it('shows remote PR state and opens its link without opening the lane', async () => {
  const host = useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]!
  const lane = { ...host.lanes[0]!, branch: 'remote-task' }
  host.lanes[0] = lane
  usePullRequestsStore.setState({
    byRepo: {
      [remotePrKey(MOCK_HOST_ID, lane.repositoryId)]: {
        byBranch: {
          [lane.branch!]: {
            number: 42,
            title: 'Remote PR',
            state: 'MERGED',
            url: 'https://github.com/a/b/pull/42',
          },
        },
        complete: true,
        loading: false,
        fetchedAt: 1,
        attemptedAt: 1,
      },
    },
  })
  render()
  const chip = container.querySelector<HTMLElement>('[data-testid=session-pr-badge]')!
  expect(chip.dataset.variant).toBe('merged')
  await act(async () => chip.click())
  expect(invoke).toHaveBeenCalledWith('app:openExternal', 'https://github.com/a/b/pull/42')
  expect(invoke).not.toHaveBeenCalledWith('hosts:openLane', expect.anything(), expect.anything())
  menu()
  expect(button('Open pull request #42')).toBeTruthy()
  usePullRequestsStore.setState({ byRepo: {} })
})
it('prefers the live name, then Host summary, then first prompt without local naming', () => {
  expect(remoteLaneTitle('Live', 'Summary', 'Prompt')).toBe('Live')
  expect(remoteLaneTitle('', 'Summary', 'Prompt')).toBe('Summary')
  expect(remoteLaneTitle(null, null, ' First prompt\nsecond line')).toBe('First prompt')
  render()
  expect(invoke).not.toHaveBeenCalled()
})
it('uses the local context-menu host and gates controller actions for a viewer', () => {
  const host = useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]!
  host.lanes[0]!.control.controller = null
  render()
  menu()
  expect(button('Rename').disabled).toBe(true)
  expect(button('Stop').disabled).toBe(true)
  expect(button('Delete').disabled).toBe(true)
  expect(button('Take control').disabled).toBe(false)
  expect(document.body.textContent).not.toContain('Fork')
  // A viewer is told how to get the action, not that it does not exist.
  for (const action of ['Rename', 'Stop', 'Delete'])
    expect(button(action).textContent).toContain(TAKE_CONTROL_FIRST)
  expect(document.body.textContent).not.toContain(REMOTE_UNAVAILABLE)
})
it('names the one obstacle a disabled controller action has', () => {
  expect(remoteControlHint(false, true, true)).toBe(REMOTE_NOT_READY)
  expect(remoteControlHint(true, false, true)).toBe(REMOTE_UNAVAILABLE)
  expect(remoteControlHint(true, true, false)).toBe(TAKE_CONTROL_FIRST)
  expect(remoteControlHint(true, true, true)).toBeUndefined()
})
it('a controller of a stopped lane can delete it, and rename says why it waits', () => {
  const host = useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]!
  host.lanes[0] = { ...host.lanes[0]!, activity: 'stopped' }
  render()
  menu()
  expect(button('Delete').disabled).toBe(false)
  expect(button('Rename').disabled).toBe(true)
  expect(button('Rename').textContent).toContain(ONLY_WHILE_RUNNING)
})
it('renames inline through the remote session and waits for success', async () => {
  render()
  menu()
  act(() => button('Rename').click())
  const input = document.querySelector<HTMLInputElement>('[aria-label="Lane name"]')!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, 'My remote title')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  )
  expect(command).toHaveBeenCalledWith(mockRemoteInfo.sessionId, {
    type: 'set_session_name',
    name: 'My remote title',
  })
})
it('keeps a failed delete in its confirm and sends explicit resource options', async () => {
  invoke.mockRejectedValue(new Error('private details'))
  render()
  menu()
  act(() => button('Delete').click())
  await act(async () => button('Delete session').click())
  expect(invoke).toHaveBeenCalledWith('hosts:deleteLane', MOCK_HOST_ID, mockRemoteInfo.laneId, {
    removeWorktree: false,
    removeBranch: false,
  })
  expect(document.querySelector('[role=alert]')?.textContent).toContain('could not delete')
  expect(document.body.textContent).not.toContain('private details')
  expect(useSessionsStore.getState().activeSessionId).toBe(mockRemoteInfo.sessionId)
})

it.each(['stopped', 'failed', 'offline'] as const)(
  'never shows a live indicator for %s',
  (activity) => {
    const host = useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]!
    host.lanes[0] = {
      ...host.lanes[0]!,
      attention: 0,
      read: 0,
      activity: activity === 'offline' ? 'idle' : activity,
    }
    render(activity !== 'offline')
    expect(container.querySelector('[data-state=live]')).toBeNull()
    expect(container.querySelector('[data-state=disk]')).not.toBeNull()
  },
)
it('releases control through the Host row menu', async () => {
  render()
  menu()
  await act(async () => button('Release control').click())
  expect(invoke).toHaveBeenCalledWith('hosts:releaseControl', MOCK_HOST_ID, mockRemoteInfo.laneId)
})
it('delete requires workspace-write capability even for the current controller', () => {
  useRemoteLanesStore.setState((s) => ({
    hosts: {
      [MOCK_HOST_ID]: {
        ...s.hosts[MOCK_HOST_ID]!,
        capabilities: ['sessions.read', 'sessions.control'],
      },
    },
  }))
  render()
  menu()
  expect(button('Delete').disabled).toBe(true)
  expect(button('Delete').textContent).toContain(REMOTE_UNAVAILABLE)
})

it.each([false, true])(
  'exclusive worktree deletion closes the open lane and reports branchKept %s',
  async (branchKept) => {
    invoke.mockResolvedValue({ branchKept })
    const toast = vi.spyOn(useExtensionUiStore.getState(), 'pushToast').mockReturnValue(1)
    const host = useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]!
    host.lanes[0] = { ...host.lanes[0]!, worktree: true }
    render()
    menu()
    act(() => button('Delete').click())
    const options = [...document.querySelectorAll<HTMLInputElement>('input[type=checkbox]')]
    expect(options.filter((input) => input.checked)).toHaveLength(3)
    await act(async () => button('Delete lane').click())
    expect(invoke).toHaveBeenCalledWith('hosts:deleteLane', MOCK_HOST_ID, mockRemoteInfo.laneId, {
      removeWorktree: true,
      removeBranch: true,
    })
    await act(async () => {
      await vi.waitFor(() => expect(useSessionsStore.getState().activeSessionId).toBeNull())
    })
    if (branchKept) expect(toast).toHaveBeenCalledWith("Branch kept: it isn't merged yet.", 'info')
    else expect(toast).not.toHaveBeenCalled()
    toast.mockRestore()
  },
)
it('projects live names reactively by Host/lane identity rather than stale summary or another Host', () => {
  const lane = mockRemoteHosts[MOCK_HOST_ID]!.lanes[0]!
  const remote = (hostId: string, phosphorId: string) => ({
    phosphorId,
    workspacePath: phosphorId,
    target: { kind: 'remote' as const, hostId },
    laneId: lane.laneId,
  })
  useSessionsStore.setState({
    live: { other: remote('other', 'other'), current: remote(MOCK_HOST_ID, 'current') },
  })
  for (const sessionId of ['other', 'current']) {
    useChatStore.getState().ensure(sessionId)
    useChatStore.getState().setMeta(sessionId, {
      sessionId,
      thinkingLevel: 'off',
      isStreaming: false,
      isCompacting: false,
      steeringMode: 'all',
      followUpMode: 'all',
      autoCompactionEnabled: true,
      messageCount: 0,
      pendingMessageCount: 0,
    })
  }
  act(() => useChatStore.getState().patchMeta('other', { sessionName: 'Wrong Host' }))
  act(() => root.render(<RemoteLaneRow lane={lane} hostId={MOCK_HOST_ID} ready />))
  expect(container.textContent).toContain(lane.title)
  act(() => useChatStore.getState().patchMeta('current', { sessionName: 'Live title' }))
  expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('Live title')
  expect(container.textContent).not.toContain('Wrong Host')
})
it('holds navigation and the menu while the Host is not ready', () => {
  const navigate = vi.fn()
  act(() =>
    root.render(
      <NavigationProvider value={{ location: { to: 'lanes' }, navigate }}>
        <RemoteLaneRow
          hostId={MOCK_HOST_ID}
          lane={useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]!.lanes[0]!}
          ready={false}
        />
        <ContextMenuHost />
      </NavigationProvider>,
    ),
  )
  const row = container.querySelector('button')!
  expect(row.disabled).toBe(true)
  act(() => row.click())
  expect(navigate).not.toHaveBeenCalled()
  menu()
  expect(document.querySelector('[data-testid=context-menu]')).toBeNull()
})
