// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RemoteLanes } from './RemoteLanes'
import { RemoteLaneControls } from '@/features/machines/RemoteLaneControls'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useMachinesStore } from '@/stores/machines'
import { useFilesStore } from '@/stores/files'

vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
let root: Root
let container: HTMLDivElement
const invoke = vi.fn().mockResolvedValue(undefined)
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(window, 'phosphor', { configurable: true, value: { invoke } })
  useMachinesStore.setState({ remoteEnabled: true })
  useRemoteLanesStore.setState({ hosts: structuredClone(mockRemoteHosts), filter: 'all' })
  useSessionsStore.setState({
    live: {
      [mockRemoteInfo.sessionId]: {
        phosphorId: mockRemoteInfo.sessionId,
        workspacePath: mockRemoteInfo.workspacePath,
        target: mockRemoteInfo.target,
        laneId: mockRemoteInfo.laneId,
      },
    },
  })
  invoke.mockClear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('offers bulk lane selection in a remote repository menu', () => {
  act(() => root.render(<RemoteLanes />))
  const options = container.querySelector<HTMLButtonElement>('[aria-label^="Workspace options"]')!
  act(() => options.click())
  expect(document.body.textContent).toContain('Select all lanes')
})

it('selects remote lanes and confirms bulk deletion through Host commands only', async () => {
  const host = structuredClone(mockRemoteHosts)[MOCK_HOST_ID]!
  host.capabilities.push('workspaces.write')
  host.lanes[0]!.control.controller = { self: true, label: 'You', connected: true }
  host.lanes.push({
    ...host.lanes[0]!,
    laneId: '00000000-0000-4000-8000-000000000097',
    title: 'Second lane',
  })
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host } })
  useSessionsStore.setState({ bulkDelete: null, live: {} })
  invoke.mockImplementation(async (channel: string) =>
    channel === 'hosts:deleteLane' ? { branchKept: false } : undefined,
  )
  act(() => root.render(<RemoteLanes />))
  act(() =>
    container.querySelector<HTMLButtonElement>('[aria-label^="Workspace options"]')!.click(),
  )
  const click = (text: string) => {
    const button = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent === text,
    )!
    button.click()
  }
  act(() => click('Select all lanes'))
  expect(container.querySelectorAll('[role=checkbox][aria-checked=true]')).toHaveLength(2)
  act(() => click('Delete…'))
  expect(invoke.mock.calls.filter(([c]) => c === 'hosts:deleteLane')).toHaveLength(0)
  await act(async () => click('Delete 2 lanes'))
  expect(invoke.mock.calls.filter(([c]) => c === 'hosts:deleteLane')).toHaveLength(2)
  expect(
    invoke.mock.calls.filter(([c]) => c.startsWith('sessions:') || c.startsWith('git:')),
  ).toHaveLength(0)
  expect(useSessionsStore.getState().bulkDelete).toMatchObject({ running: false, done: 2 })
  invoke.mockReset().mockResolvedValue(undefined)
})

it('stays dormant without sessions.read and shows unread machine-tagged lanes when enabled', () => {
  act(() => root.render(<RemoteLanes />))
  expect(container.textContent).toContain('Remote demo lane')
  expect(container.querySelector('[data-state="unseen"]')).not.toBeNull()
  act(() =>
    useRemoteLanesStore.setState({
      hosts: { [MOCK_HOST_ID]: { ...mockRemoteHosts[MOCK_HOST_ID]!, capabilities: [] } },
    }),
  )
  expect(container.querySelector('[data-testid=remote-session-row]')).toBeNull()
})

it('keeps offline lanes visible and disabled', () => {
  const hosts = structuredClone(mockRemoteHosts)
  hosts[MOCK_HOST_ID]!.state = 'reconnecting'
  useRemoteLanesStore.setState({ hosts })
  act(() => root.render(<RemoteLanes />))
  expect(container.textContent).toContain('last known')
  expect(
    container.querySelector<HTMLButtonElement>('[data-testid=remote-session-row]')?.disabled,
  ).toBe(true)
})

it('requires explicit takeover and sends the Host identity', async () => {
  act(() => root.render(<RemoteLaneControls sessionId={mockRemoteInfo.sessionId} />))
  expect(container.textContent).toContain('Controlled by Another Desktop')
  expect(invoke).not.toHaveBeenCalled()
  await act(async () => container.querySelector<HTMLButtonElement>('button')?.click())
  expect(invoke).toHaveBeenCalledWith('hosts:takeControl', MOCK_HOST_ID, mockRemoteInfo.laneId)
})

it('does not open a local file for a remote workspace key', async () => {
  await expect(
    useFilesStore.getState().openFile(mockRemoteInfo.workspacePath, '/etc/passwd'),
  ).rejects.toThrow('Not available on remote lanes yet.')
  expect(invoke).not.toHaveBeenCalled()
})

it.each([
  ['A machine needs at least one folder. Add another first.', true],
  ['private host detail /home/user/repo', false],
])('shows only the fixed last-folder refusal verbatim (%s)', async (message, verbatim) => {
  const host = structuredClone(mockRemoteHosts)[MOCK_HOST_ID]!
  host.capabilities.push('workspaces.write')
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host }, filter: 'all' })
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'hosts:removeRepository')
      throw new Error(`Error invoking remote method 'hosts:removeRepository': Error: ${message}`)
  })
  act(() => root.render(<RemoteLanes />))
  const button = (match: (b: HTMLButtonElement) => boolean) => {
    const found = [...document.body.querySelectorAll('button')].find(match)
    if (!found) throw new Error('Missing button')
    return found
  }
  act(() => button((b) => !!b.getAttribute('aria-label')?.startsWith('Workspace options')).click())
  act(() => button((b) => !!b.textContent?.startsWith('Remove')).click())
  await act(async () => button((b) => b.textContent === 'Remove folder').click())
  const alert = document.body.querySelector('[role="alert"]')?.textContent
  expect(alert).toBe(
    verbatim ? message : 'The Host could not remove this folder. Stop its lanes before retrying.',
  )
  invoke.mockReset().mockResolvedValue(undefined)
})

it.each([true, false])(
  'offers Add folder on a ready Host with no folders when it can write workspaces (%s)',
  (writable) => {
    const host = structuredClone(mockRemoteHosts)[MOCK_HOST_ID]!
    host.repositories = []
    host.lanes = []
    if (writable) host.capabilities.push('workspaces.write')
    useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host }, filter: MOCK_HOST_ID })
    act(() => root.render(<RemoteLanes />))
    expect(container.textContent).toContain('No folders yet')
    const add = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.startsWith('Add folder on'),
    )
    expect(!!add).toBe(writable)
    if (add) {
      act(() => add.click())
      expect(document.body.textContent).toContain('Choose a folder')
    }
  },
)
