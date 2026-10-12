// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest'
import { SWARM_COMMAND, SWARM_STATUS_KEY } from '@phosphor/pi-extensions/swarm'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useChatStore } from '@/stores/chat'
import { SwarmSwitch, SwarmBadge } from './SwarmSwitch'

const piCommand = vi.fn()
let root: Root
let container: HTMLDivElement
beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
beforeEach(() => {
  piCommand
    .mockReset()
    .mockImplementation(async (_id, command) =>
      command.type === 'get_commands'
        ? { success: true, data: { commands: [{ name: SWARM_COMMAND, source: 'extension' }] } }
        : { success: true },
    )
  Object.defineProperty(window, 'phosphor', { configurable: true, value: { piCommand } })
  useChatStore.setState({ sessions: {} })
  useChatStore.getState().ensure('one')
  useExtensionUiStore.setState({ statuses: {} })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
function status(enabled: boolean, requested = enabled, available = true, sessionId = 'one') {
  act(() =>
    useExtensionUiStore.getState().handleRequest(sessionId, {
      type: 'extension_ui_request',
      id: 'status',
      method: 'setStatus',
      statusKey: SWARM_STATUS_KEY,
      statusText: JSON.stringify({ version: 1, available, enabled, requested }),
    }),
  )
}
function render() {
  act(() =>
    root.render(
      <>
        <SwarmSwitch sessionId="one" />
        <SwarmBadge sessionId="one" />
      </>,
    ),
  )
  return container.querySelector('button')!
}

it('requires native capability, including for older sessions', () => {
  const button = render()
  expect(button.disabled).toBe(true)
  status(false, false, false)
  expect(button.disabled).toBe(true)
  expect(button.title).toContain('pi-subagents')
  status(false)
  expect(button.disabled).toBe(false)
})
it('sends only the host command, keeps the transcript untouched and waits for native state', async () => {
  status(false)
  const button = render()
  await act(async () => {
    button.click()
    button.click()
  })
  expect(piCommand.mock.calls).toEqual([
    ['one', { type: 'get_commands' }],
    ['one', { type: 'prompt', message: '/phosphor-swarm on' }],
  ])
  expect(button.getAttribute('aria-checked')).toBe('false')
  expect(useChatStore.getState().sessions.one!.items).toEqual([])
  status(true)
  expect(button.getAttribute('aria-checked')).toBe('true')
  expect(
    container.querySelector('[title="Swarm authorization enabled for this lane"]'),
  ).not.toBeNull()
  await act(async () => button.click())
  expect(piCommand).toHaveBeenLastCalledWith('one', {
    type: 'prompt',
    message: '/phosphor-swarm off',
  })
  expect(button.getAttribute('aria-checked')).toBe('true')
  status(false)
  expect(button.getAttribute('aria-checked')).toBe('false')
})
it('shows a pending change without claiming it is already applied, and allows cancellation', async () => {
  status(false, true)
  const button = render()
  expect(button.textContent).toContain('On next turn')
  expect(button.getAttribute('aria-checked')).toBe('false')
  expect(button.getAttribute('aria-busy')).toBe('true')
  await act(async () => button.click())
  expect(piCommand).toHaveBeenLastCalledWith('one', {
    type: 'prompt',
    message: '/phosphor-swarm off',
  })
  status(true, false)
  expect(button.textContent).toContain('Off next turn')
  expect(button.getAttribute('aria-checked')).toBe('true')
})
it('does not fall back to a model prompt when the command disappeared', async () => {
  status(false)
  piCommand.mockResolvedValue({ success: true, data: { commands: [] } })
  const button = render()
  await act(async () => button.click())
  expect(piCommand).toHaveBeenCalledTimes(1)
  expect(useChatStore.getState().sessions.one!.error).toContain('does not support')
  expect(button.getAttribute('aria-checked')).toBe('false')
})
it.each(['envelope', 'transport'])(
  'reports %s failures without optimistic enabled styling',
  async (kind) => {
    status(false)
    const button = render()
    if (kind === 'envelope') piCommand.mockResolvedValue({ success: false, error: 'Unavailable' })
    else piCommand.mockRejectedValue(new Error('Unavailable'))
    await act(async () => button.click())
    expect(useChatStore.getState().sessions.one!.error).toBeTruthy()
    expect(button.getAttribute('aria-checked')).toBe('false')
    expect(button.disabled).toBe(false)
  },
)
it('ignores other lanes and permits clearing saved authorization when the extension is missing', async () => {
  status(false)
  const button = render()
  status(true, true, true, 'other')
  expect(button.getAttribute('aria-checked')).toBe('false')
  status(false, true, false)
  expect(button.disabled).toBe(false)
  await act(async () => button.click())
  expect(piCommand).toHaveBeenLastCalledWith('one', {
    type: 'prompt',
    message: '/phosphor-swarm off',
  })
})
