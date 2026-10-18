// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FuzzyFinder, useFinderStore } from './FuzzyFinder'

vi.mock('@/stores/layout', () => ({ openFileInWorkspace: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./fileActions', () => ({
  runFileAction: (action: Promise<unknown>) => void action.catch(() => {}),
}))
const invoke = vi.fn()
let root: Root
let host: HTMLDivElement
let origin: HTMLButtonElement

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Element.prototype.scrollIntoView = vi.fn()
  invoke.mockReset().mockResolvedValue(['src/a.ts'])
  Object.assign(window, { phosphor: { invoke } })
  useFinderStore.setState({ open: false })
  host = document.createElement('div')
  origin = document.createElement('button')
  document.body.append(origin, host)
  origin.focus()
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  origin.remove()
})
const show = async () => {
  await act(async () => {
    root.render(<FuzzyFinder workspacePath="/repo" />)
    useFinderStore.getState().setOpen(true)
  })
}

it('focuses the combobox, exposes selected results and restores focus on Escape', async () => {
  await show()
  const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!
  expect(document.activeElement).toBe(input)
  expect(document.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain(
    'a.ts',
  )
  act(() =>
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }),
    ),
  )
  expect(useFinderStore.getState().open).toBe(true)
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(document.querySelector('[role="combobox"]')).toBeNull()
  expect(document.activeElement).toBe(origin)
})

it('resets the query before focusing a reopened finder', async () => {
  await show()
  const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'a.ts')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(input.value).toBe('a.ts')
  act(() => useFinderStore.getState().setOpen(false))
  const focusedValues: string[] = []
  const onFocus = (event: FocusEvent) => {
    if (
      event.target instanceof HTMLInputElement &&
      event.target.getAttribute('role') === 'combobox'
    )
      focusedValues.push(event.target.value)
  }
  document.addEventListener('focusin', onFocus)
  try {
    await show()
    expect(focusedValues).toEqual([''])
  } finally {
    document.removeEventListener('focusin', onFocus)
  }
})

it('shows index failures instead of reporting no matching files', async () => {
  invoke.mockRejectedValue(new Error('Permission denied'))
  await show()
  expect(document.querySelector('[role="status"]')?.textContent).toContain('Permission denied')
})

it('ignores a stale file index after the workspace changes', async () => {
  let finish!: (files: string[]) => void
  invoke.mockReturnValueOnce(
    new Promise<string[]>((resolve) => {
      finish = resolve
    }),
  )
  invoke.mockResolvedValueOnce(['other.ts'])
  await show()
  expect(document.querySelector('[role="status"]')?.textContent).toBe('Loading files…')
  await act(async () => root.render(<FuzzyFinder workspacePath="/other" />))
  await act(async () => finish(['wrong.ts']))
  expect(document.querySelector('[role="listbox"]')?.textContent).toContain('other.ts')
  expect(document.querySelector('[role="listbox"]')?.textContent).not.toContain('wrong.ts')
})
