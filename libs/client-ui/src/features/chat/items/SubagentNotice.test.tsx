// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CustomItem } from '../reducer'
import { SubagentNoticeItem } from './SubagentNotice'

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

const RUN = '9ef85202-56e5-4ba7-93f0-bfeaf797db99'
const OTHER = '5e7fa15d-c6dc-4fe9-8039-c3350fae64ec'
const notify = (text: string, details?: unknown): CustomItem => ({
  id: 'n',
  kind: 'custom',
  customType: 'subagent-notify',
  text,
  details,
  inContext: true,
  timestamp: Date.UTC(2026, 9, 13, 15, 0),
})
const render = (item: CustomItem, onInspect?: (runId: string) => void): void => {
  act(() => root.render(<SubagentNoticeItem item={item} onInspect={onInspect} />))
}
const header = (): HTMLButtonElement => el.querySelector('button[aria-expanded]')!
const button = (name: string): HTMLButtonElement | undefined =>
  [...el.querySelectorAll('button')].find((b) => b.textContent === name)
const body = (): string =>
  el.querySelector('[data-testid="subagent-notice-body"]')?.textContent ?? ''

it('folds a failure to one line and links its run without opening it', () => {
  const onInspect = vi.fn()
  render(
    notify(
      'Background task failed: **worker**\n\nWebSocket closed 1000 Required structured output',
      {
        runs: [{ agent: 'worker', status: 'failed', runId: RUN }],
      },
    ),
    onInspect,
  )
  expect(el.textContent).toContain('worker failed in the background')
  expect(el.querySelector('[data-status="failed"]')).not.toBeNull()
  expect(header().getAttribute('aria-expanded')).toBe('false')
  expect(el.textContent).not.toContain('WebSocket closed')

  act(() => button('Inspect run')!.click())
  expect(onInspect).toHaveBeenCalledWith(RUN)
  expect(header().getAttribute('aria-expanded')).toBe('false')

  act(() => header().click())
  expect(body()).toContain('WebSocket closed')
  expect(body()).toContain('run 9ef85202')
})

it('offers no run link without native identity, and never reads one from the prose', () => {
  render(
    notify(
      `Background task completed: **scout**\n\nscout: done\n\nRetention-managed async directory: /tmp/async/${RUN}`,
    ),
    vi.fn(),
  )
  expect(button('Inspect run')).toBeUndefined()
  act(() => header().click())
  expect(body()).toContain('scout: done')
  expect(body()).not.toContain('run 9ef85202')
})

it('lists each run of a grouped completion behind the disclosure', () => {
  const onInspect = vi.fn()
  render(
    notify('Background tasks completed (2): **reviewer**, **scout**\n\n1. reviewer\n2. scout', {
      runs: [
        { agent: 'reviewer', runId: RUN },
        { agent: 'scout', runId: OTHER },
      ],
    }),
    onInspect,
  )
  // Two runs: no single run to name on the folded line.
  expect(button('Inspect run')).toBeUndefined()
  act(() => header().click())
  const links = [...el.querySelectorAll('button')].filter((b) => b.textContent === 'Inspect')
  expect(links).toHaveLength(2)
  act(() => links[1]!.click())
  expect(onInspect).toHaveBeenCalledWith(OTHER)
})
