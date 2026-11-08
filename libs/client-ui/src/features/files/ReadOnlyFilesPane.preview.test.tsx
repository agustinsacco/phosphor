// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ReadOnlyFilesPane } from './ReadOnlyFilesPane'
import { openFileInWorkspace } from '@/stores/layout'
import { useFilesStore } from '@/stores/files'
import { useSessionsStore } from '@/stores/sessions'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { mockRemoteInfo, mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { PlatformProvider, COMPACT_PLATFORM } from '@/platform/Platform'

vi.mock('@/components/markdown/CodeBlock', () => ({
  CodeBlock: ({
    code,
    language,
    chatActions,
  }: {
    code: string
    language: string
    chatActions?: boolean
  }) => (
    <pre data-language={language} data-chat-actions={String(chatActions ?? true)}>
      {code}
    </pre>
  ),
}))

vi.mock('./MonacoEditor', () => ({ releaseFileModel: () => {} }))
vi.mock('@/components/markdown/Markdown', () => ({
  Markdown: ({ text }: { text: string }) => <article>{text}</article>,
}))
vi.mock('@/components/SandboxedHtml', () => ({
  SandboxedHtml: ({ html, title }: { html: string; title: string }) => (
    <iframe title={title} data-html={html} />
  ),
}))

const sessionId = mockRemoteInfo.sessionId
const source = Array.from({ length: 60 }, (_, i) => `const line${i + 1} = ${i + 1}`).join('\n')

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  useSessionsStore.setState({ live: {}, activeSessionId: null })
  useRemoteLanesStore.setState({ hosts: {} })
  useFilesStore.setState({ byWorkspace: {} })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function openFromChat(path: string, line?: number): Promise<HTMLDivElement> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useSessionsStore.setState({
    live: { [sessionId]: { phosphorId: sessionId, ...mockRemoteInfo } },
    activeSessionId: sessionId,
  })
  useRemoteLanesStore.setState({
    hosts: {
      [MOCK_HOST_ID]: {
        ...mockRemoteHosts[MOCK_HOST_ID]!,
        capabilities: ['sessions.read', 'workspaces.read'],
      },
    },
  })
  vi.stubGlobal('phosphor', {
    invoke: vi.fn(async (channel: string) =>
      channel === 'fs:listFiles' ? [path] : { content: source, binary: false, tooLarge: false },
    ),
  })
  // A chat link in this lane's transcript, as PathLink sends it.
  await openFileInWorkspace(mockRemoteInfo.workspacePath, path, line, sessionId)
  const container = document.createElement('div')
  root = createRoot(container)
  await act(async () =>
    root!.render(
      <PlatformProvider value={COMPACT_PLATFORM}>
        <ReadOnlyFilesPane sessionId={sessionId} />
      </PlatformProvider>,
    ),
  )
  return container
}

it("colours a file by its path's language, as the editor does", async () => {
  const container = await openFromChat('src/app.ts')
  expect(container.querySelector('pre')?.getAttribute('data-language')).toBe('typescript')
})

it('scrolls to the line a chat link names', async () => {
  // jsdom lays nothing out: give the code its line metrics.
  const style = window.getComputedStyle
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) =>
    element instanceof HTMLPreElement
      ? ({ ...style(element), lineHeight: '20px', paddingTop: '12px' } as CSSStyleDeclaration)
      : style(element),
  )
  const container = await openFromChat('src/app.ts', 30)
  const code = container.querySelector('pre')!
  let scroller: HTMLElement | null = code.parentElement
  while (scroller && scroller.scrollTop === 0) scroller = scroller.parentElement
  // Line 30's top: 12 px of padding and 29 lines of 20 px above it.
  expect(scroller?.scrollTop).toBe(12 + 29 * 20)
})

const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === label)

it('renders markdown, with its source one click away, as This Mac does', async () => {
  const container = await openFromChat('docs/README.md')
  // Renderers load on first use.
  await vi.waitFor(() => expect(container.querySelector('article')?.textContent).toBe(source))
  await act(async () => button(container, 'Source')?.click())
  expect(container.querySelector('article')).toBeNull()
  expect(container.querySelector('pre')?.textContent).toBe(source)
})

it.each(['site/page.html', 'art/logo.svg'])('renders %s in the sandboxed frame', async (path) => {
  const container = await openFromChat(path)
  await vi.waitFor(() =>
    expect(container.querySelector('iframe')?.getAttribute('title')).toBe(path.split('/').pop()),
  )
  expect(container.querySelector('iframe')?.getAttribute('data-html')).toContain(source)
  expect(button(container, 'Preview')?.getAttribute('aria-pressed')).toBe('true')
})

it("shows a lane's file without the chat code block's actions", async () => {
  const container = await openFromChat('scripts/setup.sh')
  expect(container.querySelector('pre')?.getAttribute('data-chat-actions')).toBe('false')
})
