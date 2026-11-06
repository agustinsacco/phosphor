// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { remotePrKey } from '@shared/host-protocol-github'
import type { GhPullRequest } from '@shared/models'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useChatStore } from '@/stores/chat'
import { usePullRequestsStore } from '@/stores/pullRequests'
import { featureNotOffered } from '@/stores/hostRefusals'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { groupRemoteLanes } from './groupRemoteLanes'
import { useGroupCollapse } from './groupCollapse'
import { RemoteRepositoryGroup } from './RemoteRepositoryGroup'

let root: Root
let container: HTMLDivElement
const invoke = vi.fn()
const host = () => useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]!
const LANE = mockRemoteHosts[MOCK_HOST_ID]!.lanes[0]!
const REPO = LANE.repositoryId

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke })
  invoke.mockReset().mockResolvedValue(undefined)
  const hosts = structuredClone(mockRemoteHosts)
  hosts[MOCK_HOST_ID]!.lanes = [
    {
      ...LANE,
      laneId: '00000000-0000-4000-8000-0000000000b1',
      title: 'Fix the login',
      branch: 'a',
    },
    { ...LANE, laneId: '00000000-0000-4000-8000-0000000000b2', title: 'Other', branch: 'b' },
  ]
  useRemoteLanesStore.setState({ hosts })
  useSessionsStore.setState({ live: {}, bulkDelete: null })
  usePullRequestsStore.setState({ byRepo: {} })
  useGroupCollapse.setState({ collapsed: null })
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
  const group = groupRemoteLanes(host().repositories, host().lanes)[0]!
  act(() => root.render(<RemoteRepositoryGroup hostId={MOCK_HOST_ID} group={group} />))
}
const titles = (): string[] =>
  [...container.querySelectorAll('[data-testid=remote-session-row]')].map(
    (row) => row.getAttribute('aria-label') ?? '',
  )
function search(query: string): void {
  act(() => container.querySelector<HTMLButtonElement>('[aria-label^="Search lanes in"]')!.click())
  const input = container.querySelector<HTMLInputElement>('[data-testid=lane-search-input]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, query)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

it('finds a Host lane by its PR number and title, normalized, as This Mac does', () => {
  const pr = { number: 412, title: 'Rebase dance', state: 'OPEN' } as GhPullRequest
  usePullRequestsStore.setState({
    byRepo: {
      [remotePrKey(MOCK_HOST_ID, REPO)]: {
        byBranch: { b: pr },
        attemptedAt: Date.now(),
        fetchedAt: Date.now(),
        loading: false,
      },
    },
  })
  render()
  search('#412')
  expect(titles()).toEqual(['Other'])
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Clear search"]')!.click())
  search('rebase')
  expect(titles()).toEqual(['Other'])
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Clear search"]')!.click())
  search('fix-the')
  expect(titles()).toEqual(['Fix the login'])
})

it("finds a Host lane by its live session name, this Host's only, ahead of the Host summary", () => {
  const remote = (hostId: string, laneId: string, phosphorId: string) => ({
    phosphorId,
    workspacePath: `host:${hostId}/lane:${laneId}`,
    target: { kind: 'remote' as const, hostId },
    laneId,
  })
  useSessionsStore.setState({
    live: {
      p1: remote(MOCK_HOST_ID, '00000000-0000-4000-8000-0000000000b1', 'p1'),
      // Another Host's session on the same lane id must not rename this one.
      p2: remote('other-host', '00000000-0000-4000-8000-0000000000b2', 'p2'),
    },
  })
  useChatStore.setState({
    sessions: {
      p1: { items: [], meta: { sessionName: 'Renamed just now' } },
      p2: { items: [], meta: { sessionName: 'Renamed elsewhere' } },
    } as never,
  })
  render()
  search('renamed')
  expect(titles()).toEqual(['Renamed just now'])
})

it("persists a Host folder's collapse in the sidebar's collapsed-groups pref, keyed by Host and folder", async () => {
  const key = `host:${MOCK_HOST_ID}/repo:${REPO}`
  invoke.mockImplementation(async (channel: string) =>
    channel === 'app:getPrefs' ? { collapsedWorkspaces: ['/local/repo'] } : undefined,
  )
  await act(async () => render())
  expect(titles()).toHaveLength(2)
  act(() => container.querySelector<HTMLButtonElement>('[aria-expanded="true"]')!.click())
  expect(titles()).toEqual([])
  await act(async () => {})
  expect(invoke).toHaveBeenCalledWith('app:setCollapsedWorkspaces', ['/local/repo', key])

  // A fresh window reads it back: the folder opens collapsed.
  act(() => root.unmount())
  root = createRoot(container)
  invoke.mockImplementation(async (channel: string) =>
    channel === 'app:getPrefs' ? { collapsedWorkspaces: [key] } : undefined,
  )
  await act(async () => render())
  expect(titles()).toEqual([])
})

it("reorders a Host folder's lanes with Alt+arrows, device-local in the sidebar's session order", async () => {
  useSessionsStore.setState({ sessionOrder: [] })
  await act(async () => render())
  expect(titles()).toEqual(['Fix the login', 'Other'])
  const second = container.querySelectorAll<HTMLElement>('[data-testid=remote-session-row]')[1]!
  act(() => {
    second.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }),
    )
  })
  expect(titles()).toEqual(['Other', 'Fix the login'])
  expect(useSessionsStore.getState().sessionOrder).toEqual([
    `host:${MOCK_HOST_ID}/lane:00000000-0000-4000-8000-0000000000b2`,
    `host:${MOCK_HOST_ID}/lane:00000000-0000-4000-8000-0000000000b1`,
  ])
  expect(invoke).toHaveBeenCalledWith(
    'app:setSessionOrder',
    useSessionsStore.getState().sessionOrder,
  )
})

it("reads a Host folder's saved lane order where no This Mac sidebar has (the browser)", async () => {
  useSessionsStore.setState({ sessionOrder: [] })
  invoke.mockImplementation(async (channel: string) =>
    channel === 'app:getPrefs'
      ? {
          pinnedSessions: [],
          sessionOrder: [
            `host:${MOCK_HOST_ID}/lane:00000000-0000-4000-8000-0000000000b2`,
            `host:${MOCK_HOST_ID}/lane:00000000-0000-4000-8000-0000000000b1`,
          ],
        }
      : undefined,
  )
  await act(async () => render())
  await act(async () => {})
  expect(titles()).toEqual(['Other', 'Fix the login'])
})

it("selecting an open Host folder's lanes leaves the collapsed-groups pref alone, as This Mac does", async () => {
  const hosts = structuredClone(useRemoteLanesStore.getState().hosts)
  hosts[MOCK_HOST_ID]!.capabilities.push('workspaces.write')
  useRemoteLanesStore.setState({ hosts })
  invoke.mockImplementation(async (channel: string) =>
    channel === 'app:getPrefs' ? { collapsedWorkspaces: [] } : undefined,
  )
  await act(async () => render())
  act(() =>
    container.querySelector<HTMLButtonElement>('[aria-label^="Workspace options for"]')!.click(),
  )
  const select = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === 'Select all lanes',
  )!
  expect(select.disabled).toBe(false)
  await act(async () => select.click())
  expect(container.querySelectorAll('[role=checkbox]').length).toBe(2)
  expect(invoke).not.toHaveBeenCalledWith('app:setCollapsedWorkspaces', expect.anything())
})

it("names the Host's missing lane control on a folder's New lane, after the readiness check", async () => {
  const hosts = structuredClone(useRemoteLanesStore.getState().hosts)
  hosts[MOCK_HOST_ID]!.capabilities = ['sessions.read']
  useRemoteLanesStore.setState({ hosts })
  await act(async () => render())
  const plus = container.querySelector<HTMLButtonElement>('[aria-label^="New lane in"]')!
  expect(plus.disabled).toBe(true)
  expect(plus.getAttribute('aria-description')).toBe(featureNotOffered('sessions.control'))
})
