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
it('renders prose and literal output without inventing tool outcomes or pairing', () => {
  render([
    { role: 'assistant', text: 'Checking the module.' },
    { role: 'assistant', text: '[tool: bash]' },
    { role: 'toolResult', text: '<script>not executable</script>' },
  ])
  expect(el.textContent).toContain('Checking the module.')
  expect(el.textContent).toContain('Tool call · bash')
  expect(el.textContent).toContain('Tool output')
  expect(el.textContent).not.toMatch(/exit 0|success|failed/)
  expect(el.querySelector('script')).toBeNull()
  expect(el.querySelector('[aria-live]')).toBeNull()
  expect(el.textContent).toContain('Bounded preview')
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
it('opens on formatted input and output with compact activity, not the transcript tail', () => {
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
        handoff={{ output: '# Parent receipt', receivedAt: 100 }}
      />,
    ),
  )
  expect(el.querySelector('[aria-label="Agent input"]')?.textContent).toContain('# Actual prompt')
  expect(el.querySelector('[aria-label="Agent output"]')?.textContent).toContain(
    'Output received by supervisor',
  )
  expect(el.querySelector('[aria-label="Agent output"]')?.textContent).toContain('# Parent receipt')
  expect(el.textContent).not.toContain('Inspected result')
  expect(el.querySelector<HTMLDetailsElement>('[data-testid="subagent-activity"]')?.open).toBe(
    false,
  )
  expect(el.textContent).toContain('0 tool calls · 1 output · 1 message')
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
  expect(el.querySelector('[aria-label="Agent output"]')?.textContent).toContain(
    'CHANGES_REQUESTED: add coverage',
  )
  expect(el.textContent).toContain('Supervisor received notification')
  expect(el.textContent).not.toContain('Output received by supervisor')
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
      />,
    ),
  )
  expect(el.textContent).toContain('Reported result')
  expect(el.textContent).toContain('delivery to the supervisor is not confirmed')
  expect(el.textContent).toContain('```json\n{\n  "answer": "ok",')
  expect(el.textContent).not.toContain('Output received by supervisor')
})
it('does not pull the reader down on refresh after a scroll-back gesture', () => {
  render([{ role: 'assistant', text: 'First snapshot' }])
  const scroller = el.querySelector('[data-testid="subagent-transcript"]')!
  Object.defineProperty(scroller, 'scrollHeight', { value: 2000 })
  act(() => scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -10, bubbles: true })))
  scroller.scrollTop = 100
  render([{ role: 'assistant', text: 'Next snapshot' }])
  expect(scroller.scrollTop).toBe(100)
  const latest = Array.from(el.querySelectorAll('button')).find(
    (b) => b.textContent === 'Jump to latest',
  )!
  act(() => latest.click())
  expect(scroller.scrollTop).toBe(2000)
})
