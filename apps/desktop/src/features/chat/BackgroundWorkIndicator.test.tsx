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
const toggle = (): HTMLButtonElement => el.querySelector('button[aria-expanded]')!
const details = (): HTMLElement => document.getElementById(toggle().getAttribute('aria-controls')!)!
const rowLabels = (): string =>
  [...el.querySelectorAll('button[aria-label]')].map((b) => b.getAttribute('aria-label')).join('\n')
const expand = (): void => {
  act(() => toggle().click())
}

it('starts compact with counts and attention, keeping task links out of keyboard navigation', () => {
  publish()
  render()
  expect(toggle().getAttribute('aria-expanded')).toBe('false')
  expect(details().hidden).toBe(true)
  expect(el.querySelector('[role="status"]')?.textContent).toContain(
    '2 subagents active · 1 needs parent attention',
  )
  expand()
  expect(toggle().getAttribute('aria-expanded')).toBe('true')
  expect(details().hidden).toBe(false)
  expect(rowLabels()).toContain('validation: running')
  expand()
  expect(details().hidden).toBe(true)
})

it('keeps missing and incomplete status visible while collapsed without opening on updates', () => {
  publish()
  render()
  snapshot.runs = []
  snapshot.omitted.runs = 1
  publish()
  expect(el.querySelector('[role="status"]')?.textContent).toContain('Snapshot incomplete')
  expect(details().hidden).toBe(true)
})

it('shows distinguishable tasks and timestamps in a newest-first queue', () => {
  const chat = useChatStore.getState().sessions.lane!
  useChatStore.setState({
    sessions: {
      lane: {
        ...chat,
        isStreaming: true,
        agentStartedAt: 1,
        tools: Object.fromEntries(
          [
            ['old', 100, 'Review schema'],
            ['new', 200, 'Review shutdown'],
          ].map(([id, startedAt, task]) => [
            id,
            {
              toolCallId: id as string,
              toolName: 'subagent',
              argsText: '',
              args: { agent: 'worker', task },
              status: 'running',
              startedAt: startedAt as number,
              output: null,
            },
          ]),
        ),
      },
    },
  })
  render()
  expand()
  const rows = [...el.querySelectorAll('button[aria-label="worker: running"]')]
  expect(rows[0]?.textContent).toContain('Review shutdown')
  expect(rows[1]?.textContent).toContain('Review schema')
  expect(rows[0]?.textContent).toContain('Started')
  expect(rows[0]?.getAttribute('title')).toContain('new')
})
it('keeps expansion through updates but starts another lane compact', () => {
  publish()
  render()
  expand()
  snapshot.runs[0]!.children[1]!.state = 'queued'
  publish()
  expect(details().hidden).toBe(false)
  expect(rowLabels()).toContain('validation: queued')
  publish(snapshot, 'other')
  act(() => root.render(<BackgroundWorkIndicator sessionId="other" />))
  expect(details().hidden).toBe(true)
  expect(toggle().getAttribute('aria-expanded')).toBe('false')
})

it('expands an idle parent’s active, named steps, not finished siblings', () => {
  publish()
  render()
  expect(strip()?.textContent).toContain(
    'Parent idle · 2 subagents active · 1 needs parent attention',
  )
  expand()
  expect(rowLabels()).toContain('validation: running · needs parent attention')
  expect(rowLabels()).toContain('qa: running')
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
    expand()
    expect(strip()?.textContent).toContain('Messages still go to the parent, not a child.')
    expect(el.querySelector('.phosphor-loader')).toBeNull()
  },
)

it('shows active descendants even after their enclosing root settles and preserves queued state', () => {
  snapshot.runs[0]!.state = 'complete'
  snapshot.runs[0]!.children[1]!.state = 'queued'
  publish()
  render()
  expand()
  expect(rowLabels()).toContain('validation: queued')
  expect(rowLabels()).toContain('qa: running')
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
    expect(el.querySelector('[role="status"]')?.textContent).toContain('Recent work')
    expect(el.querySelector('.phosphor-loader')).toBeNull()
  },
)

it('qualifies incomplete snapshots rather than inventing active work or a completed outcome', () => {
  snapshot.runs = []
  snapshot.omitted.runs = 1
  publish()
  render()
  expect(el.querySelector('[role="status"]')?.textContent).toContain('Snapshot incomplete')
  expand()
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
  expect(el.querySelector('[role="status"]')?.textContent).toContain('Status unavailable (2)')
  expect(details().hidden).toBe(true)
  expect(strip()?.textContent).toContain('0 subagents active')
  expect(strip()?.textContent).toContain('Last snapshot received')
  expect(el.querySelector('.phosphor-loader')).toBeNull()
  act(() => root.render(<></>))
  render()
  expect(rowLabels()).toContain('validation: status unavailable')
  send(lines)
  expect(strip()?.textContent).toContain('2 subagents active')
  send([`PI_SUBAGENT_ASYNC_JSON:${JSON.stringify({ ...snapshot, runs: [] })}`])
  expect(rowLabels()).toContain('validation: status unavailable')
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
  expand()
  const button = [...el.querySelectorAll('button')].find((b) =>
    b.getAttribute('aria-label')?.includes('reviewer: running'),
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
  const view = [...el.querySelectorAll('button')].find((b) => b.textContent === 'View subagents')!
  act(() => view.click())
  expect(details().hidden).toBe(true)
  expect(sessionPanes(useLayoutStore.getState(), 'lane').pane).toBe('subagents')
  expect(sessionPanes(useLayoutStore.getState(), 'other-lane').pane).toBeNull()
  act(() => useExtensionUiStore.setState({ widgets: {} }))
  expect(strip()).toBeNull()
  expect(sessionPanes(useLayoutStore.getState(), 'lane').pane).toBe('subagents')
})
