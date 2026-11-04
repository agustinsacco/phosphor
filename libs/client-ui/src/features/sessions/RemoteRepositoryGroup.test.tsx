// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { remotePrKey } from '@shared/host-protocol-github'
import type { GhPullRequest } from '@shared/models'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { usePullRequestsStore } from '@/stores/pullRequests'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { groupRemoteLanes } from './groupRemoteLanes'
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
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
}

it('finds a Host lane by its PR number and title, normalized, as This Mac does', () => {
  const pr = { number: 412, title: 'Rebase dance', state: 'OPEN' } as GhPullRequest
  usePullRequestsStore.setState({
    byRepo: {
      [remotePrKey(MOCK_HOST_ID, REPO)]: {
        byBranch: { b: pr },
        complete: true,
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
