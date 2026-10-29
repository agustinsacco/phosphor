// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Sidebar } from './Sidebar'
import { useRemoteComposer } from '@/features/home/remoteComposer'
import { useSettingsUiStore } from '@/features/settings/settingsUiStore'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useLayoutStore } from '@/stores/layout'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'

vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
let root: Root
let container: HTMLDivElement
const invoke = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  Object.defineProperty(window, 'phosphor', {
    configurable: true,
    value: {
      invoke,
      onUpdateEvent: () => () => {},
      onAccountChanged: () => () => {},
      onRoutinesChanged: () => () => {},
      onSessionsChanged: () => () => {},
    },
  })
  invoke
    .mockReset()
    .mockImplementation(async (channel: string) =>
      channel === 'app:getPrefs' || channel === 'routines:laneIndex'
        ? {}
        : channel === 'git:listWorktrees'
          ? []
          : null,
    )
  localStorage.clear()
  useMachinesStore.setState({ remoteEnabled: true, machines: [], adding: false })
  useSessionsStore.setState({ live: {}, unread: {}, disk: {}, seenSessions: {} })
  useLayoutStore.setState({ page: null })
  useSettingsUiStore.setState({ open: false })
  useRemoteComposer.setState({ target: null })
  useRemoteLanesStore.setState({
    hosts: structuredClone(mockRemoteHosts),
    filter: 'local',
    error: null,
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const button = (label: string): HTMLButtonElement => {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!found) throw new Error(`Missing ${label}`)
  return found
}
const navRow = (label: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll<HTMLButtonElement>('nav button')].find((b) =>
    b.textContent?.startsWith(label),
  )
  if (!found) throw new Error(`Missing nav row ${label}`)
  return found
}
const render = async (): Promise<void> => {
  await act(async () => root.render(<Sidebar workspacePath="" />))
}

it('lists New and the page links in order, then the machine scope, lanes and the footer', async () => {
  await render()
  const nav = container.querySelector('nav')!
  expect([...nav.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual([
    'New',
    'Artifacts',
    'Skills',
    'Routines',
    // Activity on the machines out of scope sits on the Machines row.
    'Machines1 new',
  ])
  const scope = button('Machine filter')
  const footer = container.querySelector('[data-testid="account-footer"]')!
  expect(nav.compareDocumentPosition(scope) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(scope.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(footer.querySelector('button[aria-label="Settings"]')).not.toBeNull()
  expect(container.querySelectorAll('button[aria-label="Settings"]')).toHaveLength(1)
})

it('offers This Mac, each Host, All machines and Add machine in the machine scope', async () => {
  await render()
  await act(async () => button('Machine filter').click())
  expect(
    [...document.querySelectorAll('[role=option]')].map((o) =>
      o.textContent?.startsWith('This Mac')
        ? 'This Mac'
        : o.textContent?.startsWith('All machines')
          ? 'All machines'
          : o.textContent?.startsWith(MOCK_HOST_ID)
            ? 'Host'
            : o.textContent,
    ),
  ).toEqual(['This Mac', 'Host', 'All machines', '+ Add machine'])
})

it('New opens home for This Mac and the scoped Host composer for a Host', async () => {
  useSessionsStore.setState({ activeSessionId: 'local-lane' })
  await render()
  await act(async () => navRow('New').click())
  expect(useSessionsStore.getState().activeSessionId).toBeNull()
  expect(useRemoteComposer.getState().target).toBeNull()
  await act(async () => useRemoteLanesStore.getState().setFilter(MOCK_HOST_ID))
  await act(async () => navRow('New').click())
  expect(useRemoteComposer.getState().target).toEqual({
    hostId: MOCK_HOST_ID,
    repositoryId: '0000000000000001',
  })
})

it('page links toggle their page, Machines opens the list, and the footer gear opens Settings', async () => {
  await render()
  await act(async () => navRow('Skills').click())
  expect(useLayoutStore.getState().page).toBe('skills')
  await act(async () => navRow('Skills').click())
  expect(useLayoutStore.getState().page).toBeNull()
  useMachinesStore.setState({ view: { kind: 'machine', id: MOCK_HOST_ID } })
  await act(async () => navRow('Machines').click())
  expect(useLayoutStore.getState().page).toBe('machines')
  expect(useMachinesStore.getState().view).toEqual({ kind: 'list' })
  await act(async () => button('Settings').click())
  expect(useSettingsUiStore.getState().open).toBe(true)
})

it('choosing a machine sets the persisted sidebar filter without leaving the open lane', async () => {
  useSessionsStore.setState({ activeSessionId: 'local-lane' })
  await render()
  await act(async () => button('Machine filter').click())
  const host = [...document.querySelectorAll<HTMLButtonElement>('[role=option]')].find((o) =>
    o.textContent?.startsWith(MOCK_HOST_ID),
  )!
  await act(async () => host.click())
  expect(useRemoteLanesStore.getState().filter).toBe(MOCK_HOST_ID)
  expect(useSessionsStore.getState().activeSessionId).toBe('local-lane')
})
