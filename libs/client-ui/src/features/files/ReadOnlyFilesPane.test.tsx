// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ReadOnlyFilesPane } from './ReadOnlyFilesPane'
import { useSessionsStore } from '@/stores/sessions'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { mockRemoteInfo, mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { PlatformProvider, COMPACT_PLATFORM } from '@/platform/Platform'
vi.mock('@/components/markdown/CodeBlock', () => ({
  CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
}))
it('reads real lane resources without file mutation, watcher, or editor requests', async () => {
  const sessionId = mockRemoteInfo.sessionId
  useSessionsStore.setState({ live: { [sessionId]: { phosphorId: sessionId, ...mockRemoteInfo } } })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useRemoteLanesStore.setState({
    hosts: {
      [MOCK_HOST_ID]: {
        ...mockRemoteHosts[MOCK_HOST_ID]!,
        capabilities: ['sessions.read', 'workspaces.read'],
      },
    },
  })
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'fs:listFiles') return ['fixture.txt']
    if (channel === 'fs:readFile')
      return { content: 'fixture content', binary: false, tooLarge: false }
    throw new Error(`Unexpected IPC ${channel}`)
  })
  vi.stubGlobal('phosphor', { invoke })
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () =>
    root.render(
      <PlatformProvider value={COMPACT_PLATFORM}>
        <ReadOnlyFilesPane sessionId={sessionId} />
      </PlatformProvider>,
    ),
  )
  const row = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('fixture.txt'),
  )
  expect(row).toBeDefined()
  await act(async () => row?.click())
  expect(container.textContent).toContain('fixture content')
  expect(container.querySelector('textarea')).toBeNull()
  expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['fs:listFiles', 'fs:readFile'])
  await act(async () => root.unmount())
  useSessionsStore.setState({ live: {} })
  useRemoteLanesStore.setState({ hosts: {} })
  vi.unstubAllGlobals()
})
