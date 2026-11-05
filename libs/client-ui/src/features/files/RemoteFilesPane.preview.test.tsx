// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { RemoteFilesPane } from './RemoteFilesPane'
import { useSessionsStore } from '@/stores/sessions'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useRemoteFileSelection } from './remoteFileSelection'
import { mockRemoteInfo, mockRemoteHosts } from '@/dev/mockRemoteLanes'

vi.mock('@/lib/monaco', () => ({}))
vi.mock('./MonacoEditor', () => ({
  releaseFileModel: vi.fn(),
  MonacoEditor: ({ value }: { value: string }) => <textarea value={value} readOnly />,
  MonacoDiff: () => null,
}))
vi.mock('@/components/markdown/Markdown', () => ({
  Markdown: ({ text }: { text: string }) => <article>{text}</article>,
}))
vi.mock('@/components/SandboxedHtml', () => ({ SandboxedHtml: () => null }))

const sessionId = mockRemoteInfo.sessionId
let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  useRemoteLanesStore.setState({ hosts: {} })
  useSessionsStore.setState({ live: {} })
  useRemoteFileSelection.setState({ bySession: {}, blocked: {} })
  vi.unstubAllGlobals()
})

it('renders a Host markdown file beside its editable source, as This Mac does', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const target = mockRemoteInfo.target
  if (target?.kind !== 'remote') throw new Error('Missing remote fixture')
  useSessionsStore.setState({ live: { [sessionId]: { phosphorId: sessionId, ...mockRemoteInfo } } })
  useRemoteLanesStore.setState({
    hosts: {
      [target.hostId]: {
        ...mockRemoteHosts[target.hostId]!,
        capabilities: ['sessions.read', 'workspaces.read'],
      },
    },
  })
  useRemoteFileSelection.setState({ bySession: { [sessionId]: { path: 'README.md' } } })
  const revision = 'a'.repeat(64)
  vi.stubGlobal('phosphor', {
    invoke: vi.fn(async (channel: string) =>
      channel === 'fs:listFiles'
        ? ['README.md']
        : channel === 'fs:readFile'
          ? { content: '# Title', binary: false, size: 7, revision }
          : {},
    ),
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
  await vi.waitFor(() => expect(container.querySelector('article')?.textContent).toBe('# Title'))
  const source = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Source')
  await act(async () => source?.click())
  expect(container.querySelector('article')).toBeNull()
  expect(container.querySelector('textarea')?.value).toBe('# Title')
})
