// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useChatStore } from '@/stores/chat'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { BackgroundWorkIndicator } from './BackgroundWorkIndicator'
import { useSubagentNavigation } from './subagentView'
import fixture from './__fixtures__/subagent-workflow.json'
import { useLayoutStore, sessionPanes } from '@/stores/layout'

let root: Root
let el: HTMLDivElement
let snapshot: typeof fixture.snapshot
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  useLayoutStore.setState({ bySession: {} })
  useChatStore.setState({ sessions: {} })
  useChatStore.getState().ensure('lane')
  useExtensionUiStore.setState({ widgets: {}, subagentSnapshots: {} })
  snapshot = structuredClone(fixture.snapshot)
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

function publish(payload: unknown = snapshot, sessionId = 'lane'): void {
  act(() =>
    useExtensionUiStore.setState({
      widgets: {
        [sessionId]: {
          'subagent-async': {
            placement: 'aboveEditor',
            lines: [`PI_SUBAGENT_ASYNC_JSON:${JSON.stringify(payload)}`],
          },
        },
      },
    }),
  )
}
function render(): void {
  act(() => root.render(<BackgroundWorkIndicator sessionId="lane" />))
}
const strip = (): Element | null => el.querySelector('[data-testid="background-work-indicator"]')

it('keeps an idle parent visibly working through its active, named steps, not finished siblings', () => {
  publish()
  render()
  expect(strip()?.textContent).toContain(
    'Parent idle · 2 subagents active · 1 needs parent attention',
  )
  expect(strip()?.textContent).toContain('validation: running · needs parent attention')
  expect(strip()?.textContent).toContain('qa: running')
  expect(strip()?.textContent).toContain('The parent is idle. You can still message it.')
  expect(strip()?.textContent).toContain('Attention signals are for the parent.')
  expect(el.querySelector('.phosphor-loader')?.getAttribute('data-animated')).toBe('true')
  expect(strip()?.textContent).not.toMatch(/tokens|seconds|approval/)
})

it.each(['streaming', 'booting', 'compacting'])(
  'does not add a second beacon while the parent is %s',
  (state) => {
    useChatStore.setState({
      sessions: {
        lane: {
          ...useChatStore.getState().sessions.lane!,
          isStreaming: state === 'streaming',
          isCompacting: state === 'compacting',
          promptSentAt: state === 'booting' ? 1 : null,
        },
      },
    })
    publish()
    render()
    expect(strip()).not.toBeNull()
    expect(strip()?.textContent).toContain('Messages still go to the parent, not a child.')
    expect(el.querySelector('.phosphor-loader')).toBeNull()
  },
)

it('shows active descendants even after their enclosing root settles and preserves queued state', () => {
  snapshot.runs[0]!.state = 'complete'
  snapshot.runs[0]!.children[1]!.state = 'queued'
  publish()
  render()
  expect(strip()?.textContent).toContain('validation: queued')
  expect(strip()?.textContent).toContain('qa: running')
})

it.each(['complete', 'failed', 'partial', 'paused', 'stopped', 'rejected'])(
  'keeps recent work when all nodes are %s, without calling it acceptance',
  (state) => {
    publish()
    render()
    snapshot.runs[0]!.state = state
    snapshot.runs[0]!.children.forEach((child) => {
      child.state = state
    })
    publish()
    expect(strip()?.textContent).toContain('0 subagents active')
    expect(strip()?.textContent).toContain('Recent work')
    expect(el.querySelector('.phosphor-loader')).toBeNull()
  },
)

it('qualifies incomplete snapshots rather than inventing active work or a completed outcome', () => {
  snapshot.runs = []
  snapshot.omitted.runs = 1
  publish()
  render()
  expect(strip()?.textContent).toContain('Snapshot incomplete')
  expect(strip()?.textContent).toContain('some work may not be shown')
  expect(el.querySelector('.phosphor-loader')).toBeNull()
})

it('stays absent for missing, foreign-lane and unsupported snapshots', () => {
  render()
  expect(strip()).toBeNull()
  publish(snapshot, 'other-lane')
  expect(strip()).toBeNull()
  publish({ ...snapshot, version: 2 })
  expect(strip()).toBeNull()
})

it('retains removed or omitted work across remounts without a stale pulse', () => {
  const send = (lines?: string[]): void => {
    act(() =>
      useExtensionUiStore.getState().handleRequest('lane', {
        type: 'extension_ui_request',
        id: 'fleet',
        method: 'setWidget',
        widgetKey: 'subagent-async',
        widgetLines: lines,
      }),
    )
  }
  const lines = [`PI_SUBAGENT_ASYNC_JSON:${JSON.stringify(snapshot)}`]
  send(lines)
  render()
  send()
  expect(strip()?.textContent).toContain('Status unavailable')
  expect(strip()?.textContent).toContain('0 subagents active')
  expect(strip()?.textContent).toContain('Last snapshot received')
  expect(el.querySelector('.phosphor-loader')).toBeNull()
  act(() => root.render(<></>))
  render()
  expect(strip()?.textContent).toContain('validation: status unavailable')
  send(lines)
  expect(strip()?.textContent).toContain('2 subagents active')
  send([`PI_SUBAGENT_ASYNC_JSON:${JSON.stringify({ ...snapshot, runs: [] })}`])
  expect(strip()?.textContent).toContain('validation: status unavailable')
  act(() => useExtensionUiStore.getState().clearSession('lane'))
  expect(strip()).toBeNull()
})

it('routes foreground work to its exact delegation without borrowing another lane', () => {
  const chat = useChatStore.getState().sessions.lane!
  useChatStore.setState({
    sessions: {
      lane: {
        ...chat,
        isStreaming: true,
        agentStartedAt: 1,
        tools: {
          fg: {
            toolCallId: 'fg',
            toolName: 'subagent',
            argsText: '',
            args: { agent: 'reviewer', task: 'Review' },
            status: 'running',
            startedAt: 1,
            output: null,
          },
        },
      },
    },
  })
  render()
  expect(strip()?.textContent).toContain('Parent working · 1 subagents active')
  const button = [...el.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('reviewer: running'),
  )!
  act(() => button.click())
  expect(useSubagentNavigation.getState().toolCallId).toBe('fg')
  expect(sessionPanes(useLayoutStore.getState(), 'lane').pane).toBe('subagents')
  act(() => root.render(<BackgroundWorkIndicator sessionId="other" />))
  expect(strip()).toBeNull()
})

it('opens this lane inspection and keeps it open when the extension removes the widget', () => {
  publish()
  render()
  act(() => el.querySelector('button')!.click())
  expect(sessionPanes(useLayoutStore.getState(), 'lane').pane).toBe('subagents')
  expect(sessionPanes(useLayoutStore.getState(), 'other-lane').pane).toBeNull()
  act(() => useExtensionUiStore.setState({ widgets: {} }))
  expect(strip()).toBeNull()
  expect(sessionPanes(useLayoutStore.getState(), 'lane').pane).toBe('subagents')
})
