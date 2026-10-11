// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { useChatStore } from '@/stores/chat'
import { useExtensionUiStore } from '@/stores/extensionUi'
import type { RpcSessionState } from '@shared/rpc'
import { SubagentPanel } from './SubagentPanel'
import { saveSubagentView } from './subagentView'
import { inspectSubagent } from './subagentInspect'
vi.mock('./subagentInspect', () => ({ inspectSubagent: vi.fn() }))
vi.mock('@/components/markdown/Markdown', () => ({
  Markdown: ({ text }: { text: string }) => <div>{text}</div>,
}))
vi.mock('@/components/Modal', () => ({
  ModalOverlay: ({ children }: { children: ReactNode }) => children,
  ModalPanel: ({ children }: { children: ReactNode }) => children,
}))
const command = vi.fn()
let root: Root
let el: HTMLDivElement
const meta = (id: string): RpcSessionState => ({
  sessionId: id,
  sessionFile: `/sessions/${id}`,
  thinkingLevel: 'off',
  isStreaming: false,
  isCompacting: false,
  steeringMode: 'all',
  followUpMode: 'all',
  autoCompactionEnabled: true,
  messageCount: 2,
  pendingMessageCount: 0,
})
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  useChatStore.setState({ sessions: {} })
  useChatStore.getState().ensure('process')
  useChatStore.getState().setMeta('process', meta('native'))
  useExtensionUiStore.setState({ widgets: {} })
  // @ts-expect-error partial preload
  window.phosphor = { piCommand: command }
  command.mockReset().mockResolvedValue({
    success: true,
    data: {
      entries: [
        {
          type: 'custom_message',
          id: 'ask',
          parentId: null,
          customType: 'subagent_supervisor_request',
          details: { requestId: 'q', runId: 'run' },
          content: 'Question',
        },
        { type: 'compaction', id: 'compact', parentId: 'ask' },
      ],
      leafId: 'compact',
    },
  })
  vi.mocked(inspectSubagent)
    .mockReset()
    .mockResolvedValue({ messages: [], truncated: false, finalOutput: 'Retained preview' })
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})
const render = async (): Promise<void> => {
  await act(async () => root.render(<SubagentPanel sessionId="process" onClose={() => {}} />))
}
it('restores an exact historical selection after compaction without recreating live work', async () => {
  saveSubagentView('native', { view: 'live', target: { runId: 'run' } })
  await render()
  expect(inspectSubagent).toHaveBeenCalledWith('process', 'run', undefined, expect.any(AbortSignal))
  expect(el.textContent).toContain('Retained preview')
  expect(el.textContent).toContain('No live snapshot')
})
it('does not restore a target on an abandoned branch or transfer preferences to a clone', async () => {
  saveSubagentView('native', { view: 'live', target: { runId: 'abandoned' } })
  await render()
  expect(inspectSubagent).not.toHaveBeenCalled()
  expect(el.textContent).toContain('not available on this branch')
  await act(async () => useChatStore.getState().setMeta('process', meta('clone')))
  expect(inspectSubagent).not.toHaveBeenCalled()
  expect(el.textContent).not.toContain('Retained preview')
})
it('restores the history tab without starting inspection', async () => {
  saveSubagentView('native', { view: 'history', target: { runId: 'run' } })
  await render()
  expect(inspectSubagent).not.toHaveBeenCalled()
  expect(el.querySelector('button[aria-pressed="true"]')?.textContent).toBe('Recorded coordination')
})
