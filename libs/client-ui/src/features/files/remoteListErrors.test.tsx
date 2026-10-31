// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RemoteFilesPane } from './RemoteFilesPane'
import { MachineFilesPane } from './MachineFilesPane'
import { useSessionsStore } from '@/stores/sessions'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { mockRemoteInfo, mockRemoteHosts } from '@/dev/mockRemoteLanes'

vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.mock('./MonacoEditor', () => ({
  releaseFileModel: vi.fn(),
  MonacoEditor: () => null,
  MonacoDiff: () => null,
}))

const TOO_MANY = 'Too many files to list: the Host stops at 20,000.'
const FAILED = "The Host couldn't list this folder."
const UNAVAILABLE = 'Not available on remote lanes yet.'
const hostId = mockRemoteInfo.target?.kind === 'remote' ? mockRemoteInfo.target.hostId : ''
const repositoryId = '1234567890abcdef'
/** What Electron's IPC makes of an Error thrown in main. */
const ipcError = (channel: string, message: string) =>
  new Error(`Error invoking remote method '${channel}': Error: ${message}`)

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const sessionId = mockRemoteInfo.sessionId
  useSessionsStore.setState({ live: { [sessionId]: { phosphorId: sessionId, ...mockRemoteInfo } } })
  useRemoteLanesStore.setState({
    hosts: {
      [hostId]: {
        connectionToken: 'test',
        state: 'ready',
        capabilities: ['sessions.read', 'workspaces.read'],
        repositories: [{ id: repositoryId, name: 'Remote repo', path: '/not-used' }],
        lanes: mockRemoteHosts[hostId]?.lanes ?? [],
      },
    },
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  useRemoteLanesStore.setState({ hosts: {} })
})

function failListing(channel: string, error: unknown): void {
  vi.stubGlobal('phosphor', {
    invoke: vi.fn(async (called: string) => {
      if (called === channel) throw error
      if (called === 'git:statusMap') return {}
      throw new Error(`Unexpected channel ${called}`)
    }),
    onSessionPush: () => () => {},
  })
}

it.each([
  [ipcError('fs:listFiles', TOO_MANY), TOO_MANY],
  [ipcError('fs:listFiles', FAILED), FAILED],
  [new Error(FAILED), FAILED],
  [ipcError('fs:listFiles', UNAVAILABLE), UNAVAILABLE],
  [ipcError('fs:listFiles', '/private/host/output'), UNAVAILABLE],
])('the lane Files pane names a failed listing: %s', async (error, shown) => {
  failListing('fs:listFiles', error)
  await act(async () =>
    root.render(
      <RemoteFilesPane
        workspacePath={mockRemoteInfo.workspacePath}
        sessionId={mockRemoteInfo.sessionId}
        changes={false}
      />,
    ),
  )
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(shown)
  expect(container.textContent).not.toContain('/private')
})

it.each([
  [ipcError('hosts:repositoryFiles', TOO_MANY), TOO_MANY],
  [ipcError('hosts:repositoryFiles', FAILED), FAILED],
  [ipcError('hosts:repositoryFiles', '/private/host/output'), UNAVAILABLE],
])('Machine files names a failed listing: %s', async (error, shown) => {
  failListing('hosts:repositoryFiles', error)
  await act(async () => root.render(<MachineFilesPane hostId={hostId} />))
  const select = container.querySelector('select')
  if (!select) throw new Error('missing select')
  await act(async () => {
    select.value = repositoryId
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(shown)
  expect(container.textContent).not.toContain('/private')
})
