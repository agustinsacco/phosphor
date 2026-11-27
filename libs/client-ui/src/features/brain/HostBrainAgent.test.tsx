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

async function render(page: HostBrainLanePage) {
  const invoke = vi.fn(async (request: HostBrainRequest) =>
    request.method === 'brain:laneShow' ? page : null,
  )
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
  expect(node.textContent).toContain('This Host can’t run messages to Brain Agent yet.')
  expect(node.querySelector('textarea')?.disabled).toBe(true)
  expect(button('Send')?.disabled).toBe(true)
})
