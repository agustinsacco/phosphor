// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrainFindResult } from '@shared/brain'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { BrainSearch } from './BrainSearch'
import { MockExplorer } from '../mockExplorer'
let container: HTMLDivElement
let root: Root
let fake: ReturnType<typeof createFakePhosphor>
let restore: () => void
const find = vi.fn<(query: string, limit: number) => Promise<BrainFindResult>>()
const select = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  find.mockReset().mockImplementation(async (q, n) => new MockExplorer().find(q, n))
  select.mockReset()
  fake = createFakePhosphor({ 'brain:find': find })
  restore = installFakePhosphor(fake)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  restore()
  fake.dispose()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
async function type(query: string): Promise<void> {
  await act(async () => {
    const input = container.querySelector('input')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, query)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function key(key: string): Promise<void> {
  await act(async () =>
    container
      .querySelector('input')!
      .dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })),
  )
}
it('debounces, ignores stale responses, and clears with Escape', async () => {
  let done!: (result: BrainFindResult) => void
  find.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        done = resolve
      }),
  )
  await act(async () => root.render(<BrainSearch onSelect={select} />))
  await type('Har')
  await act(async () => vi.advanceTimersByTimeAsync(199))
  expect(find).not.toHaveBeenCalled()
  await act(async () => vi.advanceTimersByTimeAsync(1))
  await type('Rina')
  await act(async () => vi.advanceTimersByTimeAsync(200))
  expect(container.textContent).toContain('Rina Okafor')
  await act(async () => done(new MockExplorer().find('Harbor', 12)))
  expect(container.textContent).not.toContain('Harbor component')
  await key('Escape')
  expect(container.querySelector('input')!.value).toBe('')
  expect(container.querySelector('[role="listbox"]')).toBeNull()
})
it('supports arrows/Enter, alias matches, and slash focuses search', async () => {
  await act(async () => root.render(<BrainSearch shortcut onSelect={select} />))
  act(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true })))
  expect(document.activeElement).toBe(container.querySelector('input'))
  await type('Harbor')
  await act(async () => vi.advanceTimersByTimeAsync(200))
  expect(container.textContent).toContain('matched alias: Harbor customer')
  await key('ArrowDown')
  await key('ArrowUp')
  await key('ArrowDown')
  await key('Enter')
  expect(select).toHaveBeenCalledWith({ kind: 'entity', id: 'ledger', label: 'Harbor Ledger' })
})
it('recovers a failed find without changing the query', async () => {
  find.mockRejectedValueOnce(new Error('Harbor search unavailable'))
  await act(async () => root.render(<BrainSearch onSelect={select} />))
  await type('Harbor')
  await act(async () => vi.advanceTimersByTimeAsync(200))
  expect(container.textContent).toContain('Harbor search unavailable')
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
  await act(async () => vi.advanceTimersByTimeAsync(200))
  expect(container.textContent).toContain('Harbor customer')
})
