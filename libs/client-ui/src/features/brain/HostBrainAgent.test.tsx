// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { HostBrainLanePage } from '@shared/host-brain'
import type { HostBrainRequest } from '@shared/host-brain-request'
import { HostBrainAgent } from './HostBrainAgent'
import type { ReadyBrainSurface } from './useHostBrain'

const base: HostBrainLanePage = {
  next: null,
  entries: [{ id: 'entry-1', role: 'assistant', text: 'Rina Okafor owns Harbor.' }],
  dialogs: [],
  fence: 4,
  controller: { self: true, label: 'Rina Okafor' },
  running: true,
  turn: 'turn-harbor',
  messaging: true,
}

let cleanup: (() => void) | undefined
afterEach(() => {
  cleanup?.()
  cleanup = undefined
})

async function render(
  page: HostBrainLanePage,
  watch: (cursor: string) => HostBrainLanePage = () => page,
) {
  const invoke = vi.fn(async (request: HostBrainRequest) => {
    if (request.method === 'brain:laneShow') return page
    if (request.method === 'brain:laneWatch') return watch(request.args[0]!)
    return null
  })
  const brain = { invoke, status: { generation: 'g', revision: 1 } } as unknown as ReadyBrainSurface
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const node = document.createElement('div')
  document.body.append(node)
  const root = createRoot(node)
  await act(async () => root.render(<HostBrainAgent brain={brain} />))
  cleanup = () => {
    act(() => root.unmount())
    node.remove()
    vi.unstubAllGlobals()
  }
  const button = (label: string) =>
    [...node.querySelectorAll('button')].find((b) => b.textContent === label)
  return { node, invoke, button }
}

it('stops the turn the page showed, by its reference', async () => {
  const { invoke, button } = await render(base)
  await act(async () => button('Stop')!.click())
  expect(invoke).toHaveBeenCalledWith({ method: 'brain:laneStop', args: [4, 'turn-harbor'] })
})

it('offers no Stop for a turn that is not the caller’s to stop', async () => {
  const { button } = await render({ ...base, turn: null })
  expect(button('Stop')).toBeUndefined()
})

it('says why a message cannot go when the Host runs no qualified launch', async () => {
  const { node, button } = await render({ ...base, running: false, turn: null, messaging: false })
  expect(node.querySelector('[aria-label="Transcript"]')?.textContent).toContain('owns Harbor')
  expect(node.textContent).toContain('Read-only. This Host can’t send messages yet.')
  expect(node.querySelector('textarea')).toBeNull()
  expect(button('Send')).toBeUndefined()
})

it('does not discard loaded older messages as more pages are opened', async () => {
  const { node, button } = await render({ ...base, next: '5' }, (cursor) => ({
    ...base,
    entries: [{ id: cursor, role: 'user', text: `History ${cursor}` }],
    next: Number(cursor) > 1 ? String(Number(cursor) - 1) : null,
  }))
  for (let i = 0; i < 5; i++) await act(async () => button('Older messages')!.click())
  expect(
    [...node.querySelectorAll('[aria-label="Transcript"] li')].map((li) => li.textContent),
  ).toEqual([
    'YouHistory 1',
    'YouHistory 2',
    'YouHistory 3',
    'YouHistory 4',
    'YouHistory 5',
    'Brain AgentRina Okafor owns Harbor.',
  ])
})

it('sends unmodified Enter once, not Shift+Enter or an IME commit', async () => {
  const { node, invoke } = await render({ ...base, running: false, turn: null })
  const input = node.querySelector('textarea')!
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    set.call(input, 'Synthetic draft')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    for (const init of [{ shiftKey: true }, { isComposing: true }]) {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...init }))
    }
  })
  expect(invoke.mock.calls.filter(([request]) => request.method === 'brain:laneSend')).toHaveLength(
    0,
  )
  await act(async () => {
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
  })
  expect(invoke.mock.calls.filter(([request]) => request.method === 'brain:laneSend')).toEqual([
    [{ method: 'brain:laneSend', args: ['Synthetic draft', 4] }],
  ])
})
