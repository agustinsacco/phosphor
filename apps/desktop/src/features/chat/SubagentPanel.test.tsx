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
import fixture from './__fixtures__/subagent-workflow.json'
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
  expect(el.textContent).toContain('status unavailable')
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
    startedAt: 2,
    output: null,
  }
  useChatStore.setState({
    sessions: { process: { ...chat, isStreaming: true, agentStartedAt: 1, tools: { fg: tool } } },
  })
  openForegroundSubagent('process', 'fg')
  await render()
  expect(el.querySelector('h3[tabindex="-1"]')?.textContent).toBe('Review auth')
  expect(el.textContent).toContain('running · reviewer')
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
  expect(el.textContent).not.toContain('Reviewed auth safely')
})

it('restores the history tab without starting inspection', async () => {
  saveSubagentView('native', { view: 'history', target: { runId: 'run' } })
  await render()
  expect(inspectSubagent).not.toHaveBeenCalled()
  expect(el.querySelector('button[aria-pressed="true"]')?.textContent).toBe('Coordination log')
})

const publishRuns = async (runs: unknown[]): Promise<void> => {
  await act(async () =>
    useExtensionUiStore.setState({
      widgets: {
        process: {
          'subagent-async': {
            placement: 'aboveEditor',
            lines: [`PI_SUBAGENT_ASYNC_JSON:${JSON.stringify({ ...fixture.snapshot, runs })}`],
          },
        },
      },
    }),
  )
}
const soloLaunch = {
  toolCallId: 'launch',
  toolName: 'subagent',
  argsText: '',
  args: { agent: 'worker', task: 'Write the remote brief', async: true },
  status: 'done' as const,
  startedAt: 1,
  endedAt: 2,
  output: null,
  result: { content: [], details: { asyncId: 'run', background: true } },
}
const pressed = (): string[] =>
  [...el.querySelectorAll('nav [aria-pressed="true"]')].map((b) => b.getAttribute('aria-label')!)
const header = (): string =>
  el.querySelector('h3[tabindex="-1"]')?.nextElementSibling?.textContent ?? ''

it('opens a single-agent run at its one step, from a run link or after a restart', async () => {
  const chat = useChatStore.getState().sessions.process!
  useChatStore.setState({ sessions: { process: { ...chat, tools: { launch: soloLaunch } } } })
  await publishRuns([
    {
      id: 'run',
      kind: 'subagent',
      label: 'worker',
      state: 'running',
      children: [{ id: 'step:0', kind: 'step', label: 'worker', state: 'running' }],
    },
  ])
  await render()
  await act(async () => openSubagents('process', 'run'))
  expect(inspectSubagent).toHaveBeenLastCalledWith(
    'process',
    'run',
    'step:0',
    expect.any(AbortSignal),
  )
  expect(pressed()).toEqual(['Write the remote brief · worker: running'])
  expect(el.querySelector('h3[tabindex="-1"]')?.textContent).toBe('Write the remote brief')
  // Restarted: no snapshot, only the launch, and the saved target is the step.
  act(() => root.unmount())
  root = createRoot(el)
  useExtensionUiStore.setState({ widgets: {}, subagentSnapshots: {} })
  saveSubagentView('native', { view: 'live', target: { runId: 'run', childId: 'step:0' } })
  await render()
  expect(inspectSubagent).toHaveBeenLastCalledWith(
    'process',
    'run',
    'step:0',
    expect.any(AbortSignal),
  )
  expect(pressed()).toHaveLength(1)
  expect(el.querySelector('[aria-label="Agent input"]')?.textContent).toContain(
    'Write the remote brief',
  )
  expect(el.textContent).not.toContain('can describe the containing run')
})

it('lists working groups first, selects a run by its header and never invents a duration', async () => {
  await publishRuns([
    {
      id: 'done-run',
      kind: 'subagent',
      label: 'scout',
      state: 'complete',
      startedAt: 1_000,
      children: [
        {
          id: 'step:0',
          kind: 'step',
          label: 'scout',
          state: 'complete',
          startedAt: 1_000,
          activity: { toolCount: 3 },
        },
      ],
    },
    {
      id: 'par',
      kind: 'subagent',
      label: 'reviewer, qa',
      state: 'running',
      startedAt: 2_000,
      children: [
        { id: 'step:0', kind: 'step', label: 'reviewer', state: 'complete' },
        { id: 'step:1', kind: 'step', label: 'qa', state: 'running' },
      ],
    },
  ])
  await render()
  const nav = el.querySelector('nav')!
  expect(
    [...nav.querySelectorAll('h3, button')].map(
      (n) => n.getAttribute('aria-label') ?? n.textContent,
    ),
  ).toEqual([
    'Working',
    'reviewer, qa run',
    'reviewer: complete',
    'qa: running',
    'Earlier',
    'scout: complete',
  ])
  await act(async () =>
    nav.querySelector<HTMLButtonElement>('[aria-label="reviewer, qa run"]')!.click(),
  )
  expect(inspectSubagent).toHaveBeenLastCalledWith(
    'process',
    'par',
    undefined,
    expect.any(AbortSignal),
  )
  expect(pressed()).toEqual(['reviewer, qa run'])
  await act(async () =>
    nav.querySelector<HTMLButtonElement>('[aria-label="scout: complete"]')!.click(),
  )
  // Settled with no reported end: a state and counters, not time since its start.
  expect(header()).toBe('done · 3 tools · #done-run')
})
