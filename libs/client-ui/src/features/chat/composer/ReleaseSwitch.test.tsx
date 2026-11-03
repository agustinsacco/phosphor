// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import {
  RELEASE_COMMAND,
  RELEASE_STATUS_KEY,
  type ReleaseStatus,
} from '@phosphor/pi-extensions/release-status'
import { useChatStore } from '@/stores/chat'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { ReleaseSwitch, releaseHint } from './ReleaseSwitch'

const piCommand = vi.fn()
let root: Root
let container: HTMLDivElement
let commands = [{ name: RELEASE_COMMAND, source: 'extension' }]
beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
beforeEach(() => {
  commands = [{ name: RELEASE_COMMAND, source: 'extension' }]
  piCommand
    .mockReset()
    .mockImplementation(async (_id, command) =>
      command.type === 'get_commands' ? { success: true, data: { commands } } : { success: true },
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
function status(patch: Partial<ReleaseStatus>) {
  const value = { version: 1, available: true, enabled: false, role: 'off', quiet: false, ...patch }
  act(() =>
    useExtensionUiStore.getState().handleRequest('one', {
      type: 'extension_ui_request',
      id: 'status',
      method: 'setStatus',
      statusKey: RELEASE_STATUS_KEY,
      statusText: JSON.stringify(value),
    }),
  )
}
function render() {
  act(() => root.render(<ReleaseSwitch sessionId="one" />))
  return container.querySelector('button')
}
const prompts = () =>
  piCommand.mock.calls.flatMap(([, command]) =>
    command.type === 'prompt' ? [command.message] : [],
  )

it('appears only in a repository set up for release management', () => {
  expect(render()).toBeNull()
  status({ available: false })
  expect(render()).toBeNull()
  status({ available: true })
  expect(render()?.getAttribute('aria-checked')).toBe('false')
})

it('switches release mode on and off through the extension command', async () => {
  status({})
  const off = render()
  await act(async () => off?.click())
  status({ enabled: true, role: 'active', epoch: 3, holder: 'bee2' })
  const button = render()
  expect(button?.getAttribute('aria-checked')).toBe('true')
  expect(button?.getAttribute('data-state')).toBe('active')
  await act(async () => button?.click())
  expect(prompts()).toEqual([`/${RELEASE_COMMAND} on`, `/${RELEASE_COMMAND} off`])
})

it('says who holds the lease on standby, and surfaces the last problem', () => {
  status({ enabled: true, role: 'standby', holder: 'stark', problem: 'gh pr failed: HTTP 502' })
  expect(render()?.textContent).toContain('standby')
  const hint = releaseHint({
    version: 1,
    available: true,
    enabled: true,
    role: 'standby',
    holder: 'stark',
    quiet: false,
    problem: 'gh pr failed: HTTP 502',
  })
  expect(hint).toContain('a lane on stark holds the release lease')
  expect(hint).toContain(`/${RELEASE_COMMAND} takeover`)
  expect(hint).toContain('Last problem: gh pr failed: HTTP 502')
})

it('never sends a slash command pi would hand to the model', async () => {
  commands = []
  status({})
  const button = render()
  await act(async () => button?.click())
  expect(prompts()).toEqual([])
  expect(useChatStore.getState().sessions.one?.error).toBe(
    'This lane does not support the release control. Restart it to update.',
  )
})

it('says when this lane has not claimed the lease yet, without takeover advice', () => {
  const base = { version: 1, available: true, enabled: true, quiet: false } as const
  const hint = releaseHint({ ...base, role: 'standby' })
  expect(hint).toBe('Release mode is on; this lane has not claimed the release lease yet.')
  expect(releaseHint({ ...base, role: 'standby', problem: 'offline' })).toBe(
    `${hint} Last problem: offline`,
  )
})

it('stays off, and says it is applying, until the extension acknowledges', async () => {
  let finish!: (value: unknown) => void
  piCommand.mockImplementation(async (_id, command) =>
    command.type === 'get_commands'
      ? { success: true, data: { commands } }
      : new Promise((resolve) => (finish = resolve)),
  )
  status({})
  const button = render()
  await act(async () => {
    button?.click()
    button?.click()
  })
  expect(button?.getAttribute('aria-checked')).toBe('false')
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Applying…')
  await act(async () => finish({ success: true }))
  expect(prompts()).toEqual([`/${RELEASE_COMMAND} on`])
  expect(button?.getAttribute('aria-checked')).toBe('false')
  expect(container.querySelector('[role="status"]')?.textContent).toBe('')
  status({ enabled: true, role: 'active', epoch: 1 })
  expect(render()?.getAttribute('aria-checked')).toBe('true')
})

it('shows why release mode could not change', async () => {
  piCommand.mockImplementation(async (_id, command) =>
    command.type === 'get_commands'
      ? { success: true, data: { commands } }
      : { success: false, error: 'pi is busy' },
  )
  status({})
  const button = render()
  await act(async () => button?.click())
  expect(useChatStore.getState().sessions.one?.error).toMatch(/pi is busy|Could not change/)
})
