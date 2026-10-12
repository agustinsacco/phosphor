// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { useChatStore } from '@/stores/chat'
import { useExtensionUiStore } from '@/stores/extensionUi'
import type { RpcSessionState } from '@shared/rpc'
import { SubagentPanel } from './SubagentPanel'
import {
  openForegroundSubagent,
  openSubagents,
  saveSubagentView,
  useSubagentNavigation,
} from './subagentView'
import { useLayoutStore, sessionPanes } from '@/stores/layout'
import { inspectSubagent } from './subagentInspect'
vi.mock('./subagentInspect', () => ({ inspectSubagent: vi.fn() }))
vi.mock('@/components/markdown/Markdown', () => ({
  Markdown: ({ text }: { text: string }) => <div>{text}</div>,
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
  useSubagentNavigation.setState({
    sessionId: '',
    revision: 0,
    runId: undefined,
    childId: undefined,
    toolCallId: undefined,
  })
  useLayoutStore.setState({ bySession: {}, page: null })
  useChatStore.setState({ sessions: {} })
  useChatStore.getState().ensure('process')
  useChatStore.getState().setMeta('process', meta('native'))
  useExtensionUiStore.setState({ widgets: {}, subagentSnapshots: {} })
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
  await act(async () => root.render(<SubagentPanel sessionId="process" />))
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
it('routes explicit notice links into the existing pane and validates their exact target', async () => {
  await render()
  await act(async () => openSubagents('process', 'run'))
  expect(sessionPanes(useLayoutStore.getState(), 'process').pane).toBe('subagents')
  expect(inspectSubagent).toHaveBeenLastCalledWith(
    'process',
    'run',
    undefined,
    expect.any(AbortSignal),
  )
  await act(async () => openSubagents('process', 'abandoned'))
  expect(el.textContent).toContain('not available on this branch')
  expect(el.textContent).not.toContain('Retained preview')
})
it('keeps explicit navigation until durable identity arrives', async () => {
  useChatStore.getState().ensure('starting')
  openSubagents('starting', 'run')
  await act(async () => root.render(<SubagentPanel sessionId="starting" />))
  expect(inspectSubagent).not.toHaveBeenCalled()
  await act(async () => useChatStore.getState().setMeta('starting', meta('new-native')))
  expect(inspectSubagent).toHaveBeenCalledWith(
    'starting',
    'run',
    undefined,
    expect.any(AbortSignal),
  )
})
it('opens the exact foreground tool without sending an inspection command and follows its result', async () => {
  const chat = useChatStore.getState().sessions.process!
  const tool = {
    toolCallId: 'fg',
    toolName: 'subagent',
    argsText: '',
    args: { agent: 'reviewer', task: 'Review auth' },
    status: 'running' as const,
    output: null,
  }
  useChatStore.setState({
    sessions: { process: { ...chat, isStreaming: true, tools: { fg: tool } } },
  })
  openForegroundSubagent('process', 'fg')
  await render()
  expect(el.textContent).toContain('Foreground delegation')
  expect(el.textContent).toContain('Review auth')
  expect(inspectSubagent).not.toHaveBeenCalled()
  expect(command).not.toHaveBeenCalled()
  await act(async () =>
    useChatStore.setState({
      sessions: {
        process: {
          ...chat,
          tools: {
            fg: {
              ...tool,
              status: 'done',
              output: {
                content: [],
                details: {
                  results: [
                    { agent: 'reviewer', exitCode: 0, finalOutput: 'Reviewed auth safely' },
                  ],
                },
              },
            },
          },
        },
      },
    }),
  )
  expect(el.textContent).toContain('Reviewed auth safely')
  await act(async () => useChatStore.getState().setMeta('process', meta('clone')))
  expect(el.textContent).not.toContain('Foreground delegation')
})

it('restores the history tab without starting inspection', async () => {
  saveSubagentView('native', { view: 'history', target: { runId: 'run' } })
  await render()
  expect(inspectSubagent).not.toHaveBeenCalled()
  expect(el.querySelector('button[aria-pressed="true"]')?.textContent).toBe('Recorded coordination')
})
