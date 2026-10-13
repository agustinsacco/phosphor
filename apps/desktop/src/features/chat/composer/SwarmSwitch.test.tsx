// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest'
import { SWARM_COMMAND, SWARM_STATUS_KEY } from '@phosphor/pi-extensions/swarm'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useChatStore } from '@/stores/chat'
import { SwarmSwitch, SwarmBadge, swarmAction, swarmLook } from './SwarmSwitch'

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
  useExtensionUiStore.setState({ statuses: {}, toasts: [] })
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
const toasts = (): string[] => useExtensionUiStore.getState().toasts.map((t) => t.message)

it('maps native status to the four looks', () => {
  expect(swarmLook(null)).toBe('unavailable')
  expect(swarmLook({ version: 1, available: false, enabled: false, requested: false })).toBe(
    'unavailable',
  )
  expect(swarmLook({ version: 1, available: true, enabled: false, requested: false })).toBe('off')
  expect(swarmLook({ version: 1, available: true, enabled: false, requested: true })).toBe(
    'pending',
  )
  expect(swarmLook({ version: 1, available: true, enabled: true, requested: false })).toBe(
    'pending',
  )
  expect(swarmLook({ version: 1, available: true, enabled: true, requested: true })).toBe('on')
  // Saved authorization with the tool gone: clickable (to clear it), not pending.
  expect(swarmLook({ version: 1, available: false, enabled: false, requested: true })).toBe('off')
})

it('requires native capability but keeps the unavailable explanation keyboard-accessible', async () => {
  const button = render()
  expect(button.getAttribute('aria-disabled')).toBe('true')
  expect(button.dataset.state).toBe('unavailable')
  expect(button.disabled).toBe(false)
  button.focus()
  expect(document.activeElement).toBe(button)
  status(false, false, false)
  expect(button.getAttribute('aria-disabled')).toBe('true')
  const description = document.getElementById(button.getAttribute('aria-describedby')!)
  expect(description?.textContent).toContain('pi-subagents')
  // The action hint names the click; the state's sentence is its description.
  expect(button.dataset.tooltip).toBe('Swarm')
  expect(button.dataset.tooltipDescription).toContain('pi-subagents')
  await act(async () => button.click())
  expect(piCommand).not.toHaveBeenCalled()
  status(false)
  expect(button.getAttribute('aria-disabled')).toBe('false')
  expect(button.dataset.state).toBe('off')
  expect(button.dataset.tooltip).toBe('Enable Swarm')
})
it('names the click for every look', () => {
  const s = (available: boolean, enabled: boolean, requested: boolean) =>
    ({ version: 1, available, enabled, requested }) as const
  expect(swarmAction(null)).toBe('Swarm')
  expect(swarmAction(s(false, false, false))).toBe('Swarm')
  expect(swarmAction(s(false, false, true))).toBe('Clear saved Swarm authorization')
  expect(swarmAction(s(true, false, false))).toBe('Enable Swarm')
  expect(swarmAction(s(true, true, true))).toBe('Disable Swarm')
  expect(swarmAction(s(true, false, true))).toBe('Cancel the pending change')
  expect(swarmAction(s(true, true, false))).toBe('Cancel the pending change')
})
it('keeps the switch focusable while awaiting a command and blocks repeated activation', async () => {
  status(false)
  let resolve!: (result: unknown) => void
  piCommand.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const button = render()
  button.focus()
  await act(async () => button.click())
  expect(button.disabled).toBe(false)
  expect(button.getAttribute('aria-disabled')).toBe('true')
  expect(button.dataset.applying).toBe('true')
  expect(document.activeElement).toBe(button)
  await act(async () => button.click())
  expect(piCommand).toHaveBeenCalledTimes(1)
  await act(async () => resolve({ success: true, data: { commands: [] } }))
  expect(button.getAttribute('aria-disabled')).toBe('false')
  expect(button.dataset.applying).toBeUndefined()
  expect(document.activeElement).toBe(button)
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
  expect(button.dataset.state).toBe('off')
  expect(useChatStore.getState().sessions.one!.items).toEqual([])
  status(true)
  expect(button.getAttribute('aria-checked')).toBe('true')
  expect(button.dataset.state).toBe('on')
  expect(
    container.querySelector('[data-tooltip="Swarm authorization enabled for this lane"]'),
  ).not.toBeNull()
  expect(button.dataset.tooltip).toBe('Disable Swarm')
  // Applied at once (the agent was idle): nothing to announce.
  expect(toasts()).toEqual([])
  await act(async () => button.click())
  expect(piCommand).toHaveBeenLastCalledWith('one', {
    type: 'prompt',
    message: '/phosphor-swarm off',
  })
  expect(button.getAttribute('aria-checked')).toBe('true')
  status(false)
  expect(button.getAttribute('aria-checked')).toBe('false')
  expect(button.dataset.state).toBe('off')
})
it('plays the fan-out on the off→on transition only, never on mount', () => {
  status(true)
  const button = render()
  expect(button.dataset.state).toBe('on')
  expect(button.dataset.activated).toBeUndefined()
  status(false)
  expect(button.dataset.activated).toBeUndefined()
  status(true)
  expect(button.dataset.activated).toBe('true')
  status(false)
  expect(button.dataset.activated).toBeUndefined()
})
it('says a mid-run toggle waits for the turn, then shows it landing without a second notice', async () => {
  status(false)
  const button = render()
  await act(async () => button.click())
  status(false, true) // pi holds the request: a turn is running
  expect(button.dataset.state).toBe('pending')
  expect(button.textContent).toMatch(/on next turn/)
  expect(button.getAttribute('aria-checked')).toBe('false')
  expect(button.getAttribute('aria-busy')).toBe('true')
  expect(toasts()).toEqual(['Swarm turns on after this turn.'])
  status(true) // agent_end
  expect(button.dataset.state).toBe('on')
  expect(button.dataset.activated).toBe('true')
  expect(toasts()).toEqual(['Swarm turns on after this turn.'])
})
it('announces the pending state once even when the status lands before the prompt answers', async () => {
  status(false)
  piCommand.mockImplementation(async (_id, command) => {
    if (command.type === 'get_commands')
      return { success: true, data: { commands: [{ name: SWARM_COMMAND, source: 'extension' }] } }
    status(false, true)
    return { success: true }
  })
  const button = render()
  await act(async () => button.click())
  expect(button.dataset.state).toBe('pending')
  expect(toasts()).toEqual(['Swarm turns on after this turn.'])
})
it('shows a pending change without claiming it is already applied, and names a cancellation', async () => {
  status(false, true)
  const button = render()
  expect(button.dataset.state).toBe('pending')
  expect(button.textContent).toMatch(/on next turn/)
  expect(button.dataset.tooltip).toBe('Cancel the pending change')
  expect(button.getAttribute('aria-checked')).toBe('false')
  expect(button.getAttribute('aria-busy')).toBe('true')
  await act(async () => button.click())
  expect(piCommand).toHaveBeenLastCalledWith('one', {
    type: 'prompt',
    message: '/phosphor-swarm off',
  })
  status(false, false)
  expect(button.dataset.state).toBe('off')
  expect(toasts()).toEqual(['Swarm request cancelled.'])
  status(true, false)
  expect(button.dataset.state).toBe('pending')
  expect(button.textContent).toMatch(/off next turn/)
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
  'reports %s failures without optimistic enabled styling or a stale notice',
  async (kind) => {
    status(false)
    const button = render()
    if (kind === 'envelope') piCommand.mockResolvedValue({ success: false, error: 'Unavailable' })
    else piCommand.mockRejectedValue(new Error('Unavailable'))
    await act(async () => button.click())
    expect(useChatStore.getState().sessions.one!.error).toBe('Unavailable')
    expect(button.getAttribute('aria-checked')).toBe('false')
    expect(button.dataset.state).toBe('off')
    expect(button.disabled).toBe(false)
    // A later unrelated status must not cash in the failed click's receipt.
    status(false, true)
    expect(toasts()).toEqual([])
  },
)
it('ignores other lanes and permits clearing saved authorization when the extension is missing', async () => {
  status(false)
  const button = render()
  status(true, true, true, 'other')
  expect(button.getAttribute('aria-checked')).toBe('false')
  status(false, true, false)
  expect(button.disabled).toBe(false)
  expect(button.dataset.state).toBe('off')
  await act(async () => button.click())
  expect(piCommand).toHaveBeenLastCalledWith('one', {
    type: 'prompt',
    message: '/phosphor-swarm off',
  })
})
