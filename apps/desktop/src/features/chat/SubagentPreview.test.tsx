// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { SubagentPreview } from './SubagentPreview'
import type { SubagentInspection } from './subagentInspect'
vi.mock('@/components/markdown/Markdown', () => ({
  Markdown: ({ text }: { text: string }) => <p>{text}</p>,
}))
let root: Root
let el: HTMLDivElement
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})
const render = (messages: SubagentInspection['messages']): void => {
  act(() => root.render(<SubagentPreview inspection={{ messages, truncated: true }} />))
}
const section = (label: string): string =>
  el.querySelector(`[aria-label="${label}"]`)?.textContent ?? ''

it('renders prose and literal output without inventing tool outcomes or pairing', () => {
  render([
    { role: 'assistant', text: 'Checking the module.' },
    { role: 'assistant', text: '[tool: bash]' },
    { role: 'toolResult', text: '<script>not executable</script>' },
  ])
  const records = [...el.querySelectorAll('[data-testid="subagent-activity-record"] summary')]
  expect(records.map((r) => r.textContent)).toEqual([
    '›AgentChecking the module.',
    '›bash',
    '›Output<script>not executable</script>',
  ])
  expect(el.textContent).not.toMatch(/exit 0|success|failed/)
  expect(el.querySelector('script')).toBeNull()
  expect(el.querySelector('[aria-live]')).toBeNull()
  expect(el.textContent).toContain('Older activity was left out of this read.')
})

it('keeps a disclosure attached to its record as the bounded window advances', () => {
  const output = { role: 'toolResult', text: 'A stable output' }
  render([{ role: 'assistant', text: 'Earlier message' }, output])
  const detail = el.querySelector<HTMLDetailsElement>(
    '[data-testid="subagent-activity-record"]:last-child',
  )!
  detail.open = true
  render([output, { role: 'assistant', text: 'New message' }])
  expect(el.querySelector('[data-testid="subagent-activity-record"]')).toBe(detail)
  expect(detail.open).toBe(true)
})

it('opens on the result and task, with activity collapsed', () => {
  act(() =>
    root.render(
      <SubagentPreview
        inspection={{
          task: '# Actual prompt',
          finalOutput: 'Inspected result',
          messages: [
            { role: 'thinking', text: 'Consider the cases' },
            { role: 'toolResult', text: '[tool: read]' },
          ],
          truncated: false,
        }}
        handoff={{ kind: 'tool-result', output: '# Parent receipt', receivedAt: 100 }}
      />,
    ),
  )
  expect(section('Agent input')).toContain('# Actual prompt')
  expect(section('Agent output')).toContain('Received by parent')
  expect(section('Agent output')).toContain('# Parent receipt')
  expect(el.textContent).not.toContain('Inspected result')
  expect(el.querySelector('[aria-label="Live activity"]')).toBeNull()
  expect(el.querySelector<HTMLDetailsElement>('[data-testid="subagent-activity"]')?.open).toBe(
    false,
  )
  expect(el.textContent).toContain('All activity · 2 steps · 0 tool calls')
  expect(el.textContent).toContain('Thinking')
  expect(el.querySelector('[data-testid="subagent-transcript"]')?.scrollTop).toBe(0)
})

it('does not replace the answer with a notification that only references an artifact', () => {
  act(() =>
    root.render(
      <SubagentPreview
        inspection={{
          finalOutput: 'CHANGES_REQUESTED: add coverage',
          messages: [],
          truncated: false,
        }}
        handoff={{ kind: 'notification', output: 'Output: /tmp/worker.md', receivedAt: 100 }}
      />,
    ),
  )
  expect(section('Agent output')).toContain('CHANGES_REQUESTED: add coverage')
  expect(section('Agent output')).toContain("From the agent's record")
  expect(el.textContent).toContain('Parent was notified')
  expect(el.textContent).not.toContain('Received by parent')
})

it('keeps inspection-only output qualified and makes whole JSON readable', () => {
  act(() =>
    root.render(
      <SubagentPreview
        inspection={{
          finalOutput: '{"answer":"ok","checks":["unit"]}',
          messages: [],
          truncated: true,
        }}
        handoff={{ output: 'Unproven receipt' }}
      />,
    ),
  )
  expect(section('Agent output')).toContain("From the agent's record")
  expect(el.textContent).toContain('```json\n{\n  "answer": "ok",')
  expect(el.textContent).not.toContain('Received by parent')
  expect(el.textContent).not.toContain('Unproven receipt')
})

it('shows a running agent at once, newest step first, from reported kinds', () => {
  act(() =>
    root.render(
      <SubagentPreview handoff={{ input: 'Write the brief' }} live now="read · 3 tools" loading />,
    ),
  )
  expect(section('Live activity')).toContain('Now')
  expect(section('Live activity')).toContain('read · 3 tools')
  expect(section('Live activity')).toContain('Reading activity…')
  expect(section('Agent input')).toContain('Write the brief')
  // No result yet: a running agent shows what it is doing, not an empty result.
  expect(el.querySelector('[aria-label="Agent output"]')).toBeNull()
  act(() =>
    root.render(
      <SubagentPreview
        inspection={{
          messages: [
            { role: 'assistant', text: 'Looking around.' },
            { role: 'assistant', kind: 'toolCall', name: 'read', text: '[tool: read src/a.ts]' },
            { role: 'toolResult', kind: 'toolResult', isError: true, text: 'ENOENT' },
          ],
          truncated: false,
        }}
        handoff={{ input: 'Write the brief' }}
        live
        now="read · 3 tools"
      />,
    ),
  )
  const latest = [...el.querySelectorAll('[data-testid="subagent-latest"] li')]
  expect(latest.map((li) => li.textContent)).toEqual([
    'Tool errorENOENT',
    'readsrc/a.ts',
    'AgentLooking around.',
  ])
})

it('keeps the reader where they were when activity refreshes', () => {
  render([{ role: 'assistant', text: 'First snapshot' }])
  const scroller = el.querySelector('[data-testid="subagent-transcript"]')!
  scroller.scrollTop = 100
  render([{ role: 'assistant', text: 'Next snapshot' }])
  expect(scroller.scrollTop).toBe(100)
  expect(el.querySelector('[data-testid="subagent-transcript"]')).toBe(scroller)
})
