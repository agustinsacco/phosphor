// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SWARM_STATUS_KEY } from '@phosphor/pi-extensions/swarm'
import { TopBar } from './TopBar'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useChatStore } from '@/stores/chat'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {} }),
  })
})
vi.mock('@/features/worktrees/BranchControl', () => ({
  BranchControl: ({ workspacePath }: { workspacePath: string }) => (
    <button data-testid="branch-chip">{workspacePath}</button>
  ),
}))
vi.mock('@/features/chat/SessionMenu', () => ({ SessionMenu: () => null }))
vi.mock('@/features/sessions/LaneLinks', () => ({
  LaneLinks: () => <span data-testid="lane-links">#7</span>,
}))

const HOST_LANE = mockRemoteInfo.sessionId
let root: Root
let container: HTMLDivElement

function hostLane({
  local,
  branch,
  worktree,
}: {
  local: boolean
  branch: string | null
  worktree: boolean
}) {
  const hosts = structuredClone(mockRemoteHosts)
  const host = hosts[MOCK_HOST_ID]!
  host.lanes[0] = { ...host.lanes[0]!, branch, worktree }
  hosts[MOCK_HOST_ID] = local ? { ...host, local: true } : host
  useRemoteLanesStore.setState({ hosts })
}

function swarmOn(sessionId: string): void {
  useExtensionUiStore.getState().handleRequest(sessionId, {
    type: 'extension_ui_request',
    id: 'status',
    method: 'setStatus',
    statusKey: SWARM_STATUS_KEY,
    statusText: JSON.stringify({ version: 1, available: true, enabled: true, requested: true }),
  })
}

async function show(sessionId: string, workspacePath: string): Promise<HTMLElement> {
  await act(async () => {
    useSessionsStore.setState({ activeSessionId: sessionId })
    root.render(<TopBar workspacePath={workspacePath} />)
  })
  return container.querySelector('header')!
}

/** The header's chips, in document order, then the title and the PR links. */
function expectOrder(header: HTMLElement, branch: string, title: string): void {
  const nodes = [
    header.querySelector('[data-testid="machine-chip"]'),
    header.querySelector(`[data-testid="${branch}"]`),
    [...header.querySelectorAll('span')].find((el) => el.textContent === title),
    header.querySelector('[data-testid="lane-links"]'),
  ]
  for (const node of nodes) expect(node).toBeTruthy()
  for (let i = 1; i < nodes.length; i++)
    expect(
      nodes[i - 1]!.compareDocumentPosition(nodes[i]!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
}

function expectNoProjectOrSwarmBadge(header: HTMLElement): void {
  expect(header.querySelector('[data-testid="workspace-chip"]')).toBeNull()
  expect(header.textContent).not.toContain('Demo repository')
  expect(
    header.querySelector('[data-tooltip="Swarm authorization enabled for this lane"]'),
  ).toBeNull()
  expect(header.textContent).not.toContain('Swarm')
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke: vi.fn().mockResolvedValue(undefined) })
  useSessionsStore.setState({
    live: {
      mac: { phosphorId: 'mac', workspacePath: '/mac' },
      [HOST_LANE]: { ...mockRemoteInfo, phosphorId: HOST_LANE },
    },
  })
  useChatStore.setState({ sessions: {} })
  useExtensionUiStore.setState({ statuses: {}, toasts: [] })
  for (const id of ['mac', HOST_LANE]) {
    useChatStore.getState().ensure(id)
    useChatStore.getState().setMeta(id, {
      sessionId: id,
      sessionName: `Title ${id}`,
      isStreaming: false,
      isCompacting: false,
      thinkingLevel: 'off',
      steeringMode: 'all',
      followUpMode: 'all',
      autoCompactionEnabled: true,
      messageCount: 0,
      pendingMessageCount: 0,
    })
    swarmOn(id)
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

it("orders a Host lane's bar machine, read-only branch, title, PRs, with no project or Swarm badge", async () => {
  hostLane({ local: false, branch: 'main', worktree: false })
  const header = await show(HOST_LANE, mockRemoteInfo.workspacePath)
  expectOrder(header, 'lane-branch', `Title ${HOST_LANE}`)
  expectNoProjectOrSwarmBadge(header)
  expect(header.querySelector('[data-testid="machine-chip"]')?.textContent).toBe(
    `${MOCK_HOST_ID} · Connected`,
  )
  const branch = () => header.querySelector('[data-testid="lane-branch"]')
  expect(branch()?.textContent).toBe('main')
  expect(branch()?.getAttribute('data-tooltip')).toBe('Branch main')
  // The chip follows the Host's branch, and marks a worktree as the popover does.
  await act(async () => hostLane({ local: false, branch: 'agustin/lane-work', worktree: true }))
  expect(branch()?.textContent).toBe('wtagustin/lane-work')
  expect(branch()?.getAttribute('data-tooltip')).toMatch(/^Worktree of Demo repository on /)
  await act(async () => hostLane({ local: false, branch: null, worktree: false }))
  expect(branch()).toBeNull()
})

it("orders This Mac's service lane machine, branch popover, title, PRs", async () => {
  hostLane({ local: true, branch: 'main', worktree: false })
  const header = await show(HOST_LANE, mockRemoteInfo.workspacePath)
  expectOrder(header, 'branch-chip', `Title ${HOST_LANE}`)
  expectNoProjectOrSwarmBadge(header)
  expect(header.querySelector('[data-testid="lane-branch"]')).toBeNull()
  expect(header.querySelector('[data-testid="branch-chip"]')?.textContent).toBe('/remote/demo')
  // While the service reconnects the slot keeps its place with the read-only chip.
  await act(async () => {
    const hosts = structuredClone(useRemoteLanesStore.getState().hosts)
    hosts[MOCK_HOST_ID]!.state = 'reconnecting'
    useRemoteLanesStore.setState({ hosts })
  })
  expectOrder(header, 'lane-branch', `Title ${HOST_LANE}`)
})

it("orders an in-app lane's bar machine, branch popover, title, PRs, with no folder or Swarm badge", async () => {
  hostLane({ local: false, branch: 'main', worktree: false })
  const header = await show('mac', '/mac')
  expectOrder(header, 'branch-chip', 'Title mac')
  expectNoProjectOrSwarmBadge(header)
  expect(header.querySelector('[data-testid="branch-chip"]')?.textContent).toBe('/mac')
})
