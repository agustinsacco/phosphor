// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
  vi.useRealTimers()
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
const status = (): string => el.querySelector('[role="status"]')?.textContent ?? ''
const headline = (): string =>
  el.querySelector('[data-testid="current-work-headline"]')?.textContent ?? ''
const ticker = (): string =>
  el.querySelector('[data-testid="current-work-ticker"]')?.textContent ?? ''
const pulses = (): number => el.querySelectorAll('.tool-running-dot').length

it('starts compact with counts and attention, keeping task links out of keyboard navigation', () => {
  publish()
  render()
  expect(toggle().getAttribute('aria-expanded')).toBe('false')
  expect(details().hidden).toBe(true)
  expect(headline()).toBe('2 agents working · 1 needs parent attention · parent idle')
  // Parent turns are not announced; only the agents' own counts are.
  expect(status()).toBe('2 agents working · 1 needs parent attention')
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
  expect(status()).toContain('snapshot incomplete')
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
  const rows = [...el.querySelectorAll('[data-testid="subagent-work-row"]')]
  // The accessible name leads with the visible title, not the shared agent name.
  expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual([
    'Review shutdown · worker: running',
    'Review schema · worker: running',
  ])
  expect(rows[0]?.textContent).toContain('Review shutdown')
  expect(rows[1]?.textContent).toContain('Review schema')
  expect(rows[0]?.getAttribute('aria-description')).toContain('Started')
  expect(rows[0]?.getAttribute('data-tooltip')).toBe('Review shutdown')
  expect(rows[0]?.getAttribute('data-tooltip-description')).toContain('new')
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
  expect(headline()).toContain('parent idle')
  expand()
  expect(rowLabels()).toContain('validation: running · needs parent attention')
  expect(rowLabels()).toContain('qa: running')
  // A finished sibling is listed after current work, never pulsing.
  const finished = el.querySelector('button[aria-label="reviewer: complete"]')!
  const heading = [...el.querySelectorAll('p')].find((p) => p.textContent === 'Recent')!
  expect(heading.compareDocumentPosition(finished) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  // One pulse in the header, one per running row.
  expect(pulses()).toBe(3)
  expect(strip()?.textContent).not.toMatch(/tokens|approval/)
})

it.each(['streaming', 'booting', 'compacting'])(
  'reports the parent as working while it is %s, apart from its agents',
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
    expect(headline()).toBe('2 agents working · 1 needs parent attention · parent working')
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
    expect(headline()).toBe('No agents working · parent idle')
    expect(pulses()).toBe(0)
    expect(ticker()).toBe('')
    expand()
    expect(strip()?.textContent).toContain('Recent')
    expect(rowLabels()).toContain(`qa: ${state}`)
    expect(strip()?.textContent).not.toMatch(/accepted|verified/i)
  },
)

it('qualifies incomplete snapshots rather than inventing active work or a completed outcome', () => {
  snapshot.runs = []
  snapshot.omitted.runs = 1
  publish()
  render()
  expect(headline()).toBe('No agents working · snapshot incomplete · parent idle')
  expand()
  expect(strip()?.textContent).toContain('Some work was left out of the snapshot.')
  expect(pulses()).toBe(0)
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
  expect(headline()).toBe('No agents working · 2 status unavailable · parent idle')
  expect(details().hidden).toBe(true)
  expect(strip()?.textContent).toContain('no current report, not finished')
  expect(strip()?.textContent).toContain('Last report')
  expect(pulses()).toBe(0)
  act(() => root.render(<></>))
  render()
  expect(rowLabels()).toContain('validation: status unavailable')
  send(lines)
  expect(status()).toContain('2 agents working')
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
  expect(headline()).toBe('1 agent working · parent working')
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

it('shows a single-agent run once, with its task, and opens its one step', () => {
  const runId = '20000000-0000-4000-8000-000000000000'
  vi.useFakeTimers({ now: 1_000_000, toFake: ['Date', 'setInterval', 'clearInterval'] })
  const chat = useChatStore.getState().sessions.lane!
  useChatStore.setState({
    sessions: {
      lane: {
        ...chat,
        tools: {
          launch: {
            toolCallId: 'launch',
            toolName: 'subagent',
            argsText: '',
            args: {
              agent: 'worker',
              task: 'Shared preamble.\nWrite desktop-first-class.md',
              async: true,
            },
            status: 'done',
            startedAt: 900_000,
            endedAt: 900_100,
            output: null,
            result: { content: [], details: { asyncId: runId, background: true } },
          },
        },
      },
    },
  })
  const single = (currentTool?: string, lastActivityAt = 995_000) => ({
    ...snapshot,
    runs: [
      {
        id: runId,
        kind: 'subagent',
        label: 'worker',
        state: 'running',
        startedAt: 940_000,
        children: [
          {
            id: 'step:0',
            kind: 'step',
            label: 'worker',
            state: 'running',
            startedAt: 940_000,
            activity: {
              lastActivityAt,
              toolCount: 3,
              turnCount: 2,
              ...(currentTool ? { currentTool } : {}),
            },
          },
        ],
      },
    ],
  })
  publish(single('bash'))
  render()
  expect(headline()).toBe('1 agent working · parent idle')
  // A lone prompt titles by its first sentence; the distinct one wins once two share it.
  expect(ticker()).toBe('Shared preamble. · bash · 3 tools')
  expand()
  const rows = [...el.querySelectorAll('[data-testid="subagent-work-row"]')]
  expect(rows).toHaveLength(1)
  expect(rows[0]?.textContent).toContain('Shared preamble.')
  expect(rows[0]?.getAttribute('data-tooltip-description')).toContain(runId)
  expect(rows[0]?.textContent).toContain('1m 00s')
  expect(rows[0]?.textContent).not.toContain('Task not reported')
  // A pushed snapshot moves the row without any polling.
  publish(single(undefined, 998_000))
  expect(rows[0]?.isConnected).toBe(true)
  expect(el.querySelector('[data-testid="subagent-work-row"]')?.textContent).toContain(
    'worker · working · 3 tools',
  )
  // The shared clock ticks elapsed and quiet time while work runs.
  act(() => vi.advanceTimersByTime(20_000))
  expect(el.querySelector('[data-testid="subagent-work-row"]')?.textContent).toContain('quiet 22s')
  expect(el.querySelector('[data-testid="subagent-work-row"]')?.textContent).toContain('1m 20s')
  act(() => (rows[0] as HTMLButtonElement).click())
  expect(useSubagentNavigation.getState()).toMatchObject({ runId, childId: 'step:0' })
})
