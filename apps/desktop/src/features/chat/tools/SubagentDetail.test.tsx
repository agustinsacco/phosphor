// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SubagentDetail } from './SubagentDetail'
import type { ToolState } from '../chatItems'
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
const tool: ToolState = {
  toolCallId: 'call',
  toolName: 'subagent',
  argsText: '',
  status: 'done',
  output: null,
  args: {
    tasks: [
      { agent: 'worker', task: '# First task' },
      { agent: 'worker', task: '# Second task' },
    ],
  },
  result: {
    content: [{ type: 'text', text: 'Answer stored in worker.md' }],
    details: {
      results: [0, 1].map((index) => ({
        index,
        agent: 'worker',
        exitCode: 0,
        finalOutput: `Reported answer ${index}`,
      })),
    },
  },
}
it('separates actual supervisor output from child metadata and binds parallel prompts by index', () => {
  act(() => root.render(<SubagentDetail tool={tool} />))
  const receipt = el.querySelector('[data-testid="subagent-supervisor-output"]')!
  expect(receipt.textContent).toContain('Answer stored in worker.md')
  expect(receipt.textContent).not.toContain('Reported answer')
  const children = [...el.querySelectorAll('[data-testid="subagent-child"]')]
  expect(children[0]?.textContent).toContain('# First task')
  expect(children[1]?.textContent).toContain('# Second task')
  for (const child of children) {
    const output = child.querySelector<HTMLDetailsElement>('[data-testid="subagent-output"]')!
    expect(output.open).toBe(false)
    expect(output.textContent).toContain('Reported child result')
  }
})
it('does not call a detached launch acknowledgement a child result', () => {
  act(() => root.render(<SubagentDetail tool={{ ...tool, args: { ...tool.args, async: true } }} />))
  expect(el.querySelector('[data-testid="subagent-supervisor-output"]')).toBeNull()
  const withoutChildOutput = {
    ...tool,
    result: { ...tool.result!, details: { results: [{ index: 0, agent: 'worker', exitCode: 0 }] } },
  }
  act(() => root.render(<SubagentDetail tool={withoutChildOutput} />))
  expect(el.querySelector('[data-testid="subagent-supervisor-output"]')?.textContent).toContain(
    'Answer stored in worker.md',
  )
  expect(el.querySelector('[data-testid="subagent-output"]')).toBeNull()
})
