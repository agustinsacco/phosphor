// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useSessionsStore } from '@/stores/sessions'
import { useChatStore } from '@/stores/chat'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { usePullRequestsStore } from '@/stores/pullRequests'
import { useLayoutStore } from '@/stores/layout'
import type { SessionMeta } from '@shared/models'
import { LaneBoard, useLaneBoard } from './LaneBoard'

let root: Root
let el: HTMLDivElement
const cards = () => [...el.querySelectorAll('[data-testid="lane-board-card"]')]
function Home(): React.JSX.Element {
  return <LaneBoard data={useLaneBoard('/repo')} />
}
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  useSessionsStore.setState({ live: {}, disk: {}, gitByCwd: {} })
  useChatStore.setState({ sessions: {} })
  useExtensionUiStore.setState({ widgets: {}, dialogs: [] })
  usePullRequestsStore.setState({ byRepo: {} })
  useLayoutStore.setState({ bySession: {} })
  vi.spyOn(usePullRequestsStore.getState(), 'refresh').mockResolvedValue()
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  vi.restoreAllMocks()
})
it('includes first-turn worktree lanes, prefers live names and keeps their tile after saving', () => {
  useSessionsStore.setState({
    live: {
      a: { phosphorId: 'a', workspacePath: '/repo/wt' },
      other: { phosphorId: 'other', workspacePath: '/other' },
    },
    gitByCwd: {
      '/repo/wt': { isRepo: true, mainRepoPath: '/repo', branch: 'feature', isWorktree: true },
    },
  })
  useChatStore.getState().ensure('a')
  useChatStore.getState().addUserMessage('a', 'Fix the layout')
  useChatStore.getState().applyEvent('a', { type: 'agent_start' })
  act(() => root.render(<Home />))
  expect(cards()).toHaveLength(1)
  const original = cards()[0]
  expect(el.textContent).toContain('Fix the layout')
  expect(el.textContent).toContain('1 running')
  const activate = vi.spyOn(useSessionsStore.getState(), 'activate').mockImplementation(() => {})
  act(() => [...el.querySelectorAll('button')].find((b) => b.textContent === 'Open lane')!.click())
  expect(activate).toHaveBeenCalledWith('a')
  act(() => {
    useChatStore.getState().setMeta('a', {
      sessionId: 'native',
      sessionName: 'Live title',
      sessionFile: '/saved',
      thinkingLevel: 'off',
      isStreaming: false,
      isCompacting: false,
      steeringMode: 'all',
      followUpMode: 'all',
      autoCompactionEnabled: true,
      messageCount: 2,
      pendingMessageCount: 0,
    })
    useChatStore.getState().applyEvent('a', { type: 'agent_end', messages: [] })
    useSessionsStore.setState({
      live: { a: { phosphorId: 'a', workspacePath: '/repo/wt', diskPath: '/saved' } },
      disk: {
        '/repo/wt': [
          {
            path: '/saved',
            cwd: '/repo/wt',
            name: 'Stale title',
            lastActivityAt: '',
            mtimeMs: 0,
            cost: 0,
          } as SessionMeta,
        ],
      },
    })
  })
  expect(cards()).toHaveLength(1)
  expect(cards()[0]).toBe(original)
  expect(el.textContent).toContain('Live title')
  expect(el.textContent).not.toContain('Stale title')
  expect(el.textContent).toContain('1 idle')
})
it('renders observed tools and bounded background work without inspecting until asked', () => {
  useSessionsStore.setState({ live: { a: { phosphorId: 'a', workspacePath: '/repo' } } })
  useChatStore.getState().ensure('a')
  useChatStore.getState().applyEvent('a', {
    type: 'tool_execution_start',
    toolCallId: 'tool',
    toolName: 'bash',
    args: { command: 'npm test' },
  })
  useExtensionUiStore.setState({
    widgets: {
      a: {
        'subagent-async': {
          placement: 'aboveEditor',
          lines: [
            'PI_SUBAGENT_ASYNC_JSON:' +
              JSON.stringify({
                kind: 'pi-subagents.async-status-snapshot',
                version: 1,
                omitted: { runs: 1 },
                runs: [
                  {
                    id: 'run',
                    label: 'Reviewer',
                    state: 'complete',
                    children: [
                      { id: 'child', state: 'running', activity: { currentTool: 'read' } },
                    ],
                  },
                ],
              }),
          ],
        },
      },
    },
  })
  act(() => root.render(<Home />))
  expect(el.textContent).toContain('Running npm test')
  expect(el.textContent).toContain('1 background run active')
  expect(el.textContent).toContain('Partial preview')
  expect(el.textContent).not.toContain('PI_SUBAGENT_ASYNC_JSON')
  expect(useLayoutStore.getState().bySession.a).toBeUndefined()
  const activate = vi.spyOn(useSessionsStore.getState(), 'activate').mockImplementation(() => {})
  act(() =>
    [...el.querySelectorAll('button')].find((b) => b.textContent === 'View subagents')!.click(),
  )
  expect(activate).toHaveBeenCalledWith('a')
  expect(useLayoutStore.getState().bySession.a?.pane).toBe('subagents')
})
