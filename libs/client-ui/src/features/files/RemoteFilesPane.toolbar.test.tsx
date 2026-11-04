// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { HostCapability } from '@shared/remote-host'
import { RemoteFilesPane } from './RemoteFilesPane'
import { useSessionsStore } from '@/stores/sessions'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { mockRemoteInfo, mockRemoteHosts } from '@/dev/mockRemoteLanes'

vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.mock('./MonacoEditor', () => ({
  releaseFileModel: vi.fn(),
  MonacoEditor: () => null,
  MonacoDiff: () => null,
}))

const ACTIONS = ['New file', 'New folder', 'Rename', 'Trash', 'Copy to folder', 'Move to folder']

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  useRemoteLanesStore.setState({ hosts: {} })
  useSessionsStore.setState({ live: {} })
  vi.unstubAllGlobals()
})

async function renderToolbar(capabilities: HostCapability[]): Promise<HTMLDivElement> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const target = mockRemoteInfo.target
  if (target?.kind !== 'remote') throw new Error('Missing remote fixture')
  const sessionId = mockRemoteInfo.sessionId
  useSessionsStore.setState({ live: { [sessionId]: { phosphorId: sessionId, ...mockRemoteInfo } } })
  const fixture = mockRemoteHosts[target.hostId]!
  useRemoteLanesStore.setState({
    hosts: {
      [target.hostId]: {
        ...fixture,
        capabilities,
        lanes: fixture.lanes.map((lane) => ({
          ...lane,
          control: {
            ...lane.control,
            controller: { self: true, label: 'Desktop', connected: true },
          },
        })),
      },
    },
  })
  vi.stubGlobal('phosphor', {
    invoke: vi.fn(async (channel: string) => (channel === 'fs:listFiles' ? ['a.ts'] : {})),
  })
  const container = document.createElement('div')
  root = createRoot(container)
  await act(async () =>
    root!.render(
      <RemoteFilesPane
        workspacePath={mockRemoteInfo.workspacePath}
        sessionId={sessionId}
        changes={false}
      />,
    ),
  )
  return container
}

it('gives every file action its own icon', async () => {
  const container = await renderToolbar([
    'sessions.read',
    'sessions.control',
    'workspaces.read',
    'workspaces.write',
  ])
  const icons = ACTIONS.map(
    (label) => container.querySelector(`button[aria-label="${label}"] svg`)?.outerHTML,
  )
  expect(icons.every(Boolean)).toBe(true)
  expect(new Set(icons).size).toBe(ACTIONS.length)
})

it('marks a lane without write access with a read-only tag', async () => {
  const container = await renderToolbar(['sessions.read', 'workspaces.read'])
  const tag = [...container.querySelectorAll('span')].find((s) => s.textContent === 'Read only')
  expect(tag).toBeDefined()
  for (const label of ACTIONS)
    expect(container.querySelector(`button[aria-label="${label}"]`)).toBeNull()
})
