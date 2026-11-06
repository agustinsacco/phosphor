// @vitest-environment jsdom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { useSessionsStore } from '@/stores/sessions'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useRemoteFileSelection } from './remoteFileSelection'
import {
  renderRemoteFilesPane,
  remoteFilesSessionId as sessionId,
} from './__fixtures__/renderRemoteFilesPane'

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

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  useRemoteLanesStore.setState({ hosts: {} })
  useSessionsStore.setState({ live: {} })
  useRemoteFileSelection.setState({ bySession: {}, blocked: {} })
  vi.unstubAllGlobals()
})

it('renders a Host markdown file beside its editable source, as This Mac does', async () => {
  useRemoteFileSelection.setState({ bySession: { [sessionId]: { path: 'README.md' } } })
  const revision = 'a'.repeat(64)
  const pane = await renderRemoteFilesPane({
    capabilities: ['sessions.read', 'workspaces.read'],
    phosphor: {
      invoke: vi.fn(async (channel: string) =>
        channel === 'fs:listFiles'
          ? ['README.md']
          : channel === 'fs:readFile'
            ? { content: '# Title', binary: false, size: 7, revision }
            : {},
      ),
    },
  })
  root = pane.root
  const container = pane.container
  await vi.waitFor(() => expect(container.querySelector('article')?.textContent).toBe('# Title'))
  const source = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Source')
  await act(async () => source?.click())
  expect(container.querySelector('article')).toBeNull()
  expect(container.querySelector('textarea')?.value).toBe('# Title')
})
