// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ReadOnlyFilesPane } from './ReadOnlyFilesPane'
import { useRemoteFileSelection } from './remoteFileSelection'
import { useSessionsStore } from '@/stores/sessions'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { mockRemoteInfo, mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { PlatformProvider, COMPACT_PLATFORM } from '@/platform/Platform'

vi.mock('@/components/markdown/CodeBlock', () => ({
  CodeBlock: ({ code, language }: { code: string; language: string }) => (
    <pre data-language={language}>{code}</pre>
  ),
}))

const sessionId = mockRemoteInfo.sessionId
const source = Array.from({ length: 60 }, (_, i) => `const line${i + 1} = ${i + 1}`).join('\n')

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  useSessionsStore.setState({ live: {}, activeSessionId: null })
  useRemoteLanesStore.setState({ hosts: {} })
  useRemoteFileSelection.setState({ bySession: {}, blocked: {} })
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
  useRemoteFileSelection.setState({
    bySession: { [sessionId]: { path, ...(line ? { reveal: { line, seq: 1 } } : {}) } },
  })
  vi.stubGlobal('phosphor', {
    invoke: vi.fn(async (channel: string) =>
      channel === 'fs:listFiles' ? [path] : { content: source, binary: false, tooLarge: false },
    ),
  })
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
