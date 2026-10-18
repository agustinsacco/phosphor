// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { promptChoice } from '@/stores/prompt'
import { mockSettingsRead } from '@/dev/mockMachineSettings'
import { MachineProviderSettings, type MachinePrograms } from './MachineProviderSettings'
import type { HostSettingsState } from './useHostSettings'

vi.mock('@/stores/prompt', () => ({ promptChoice: vi.fn(async () => undefined) }))
let root: Root, container: HTMLDivElement
let settings: HostSettingsState
let programs: MachinePrograms
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.mocked(promptChoice).mockReset().mockResolvedValue(undefined)
  settings = {
    supported: true,
    data: mockSettingsRead('provider-test', 'providers'),
    error: null,
    loading: false,
    saving: false,
    allowed: true,
    connection: {
      state: 'ready',
      connectionToken: 'provider-test',
      capabilities: ['machine.configure', 'sessions.control'],
      repositories: [],
      lanes: [],
    },
    refresh: vi.fn(async () => {}),
    change: vi.fn(async () => null),
    check: vi.fn(async () => {}),
    moveAccount: vi.fn(async () => {}),
  }
  programs = { available: true, busy: false, login: vi.fn(), task: vi.fn() }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
function render() {
  act(() =>
    root.render(
      <MachineProviderSettings hostId="host" label="bee" settings={settings} programs={programs} />,
    ),
  )
}
function accountButton(text: string, index = 0) {
  const row = container.querySelectorAll('[data-account-id]')[index]!
  const button = [...row.querySelectorAll('button')].find(
    (entry) => entry.textContent?.trim() === text,
  )
  if (!button) throw new Error(`Missing ${text}`)
  return button
}
it('preserves expanded account usage across temporarily missing settings', () => {
  render()
  act(() => accountButton('Usage & lanes').click())
  expect(container.textContent).toContain('Unavailable is not zero')
  const data = settings.data
  settings = { ...settings, data: null }
  render()
  expect(container.textContent).toBe('')
  settings = { ...settings, data }
  render()
  expect(container.textContent).toContain('Unavailable is not zero')
})
it('keeps routing, reorder and account sign-in actions bound to Host account ids', () => {
  render()
  const ids = settings.data!.providers!.accounts.map((account) => account.id)
  act(() => accountButton('Move down').click())
  expect(settings.change).toHaveBeenCalledWith({ type: 'claude.reorder', ids: [...ids].reverse() })
  act(() => accountButton('Sign in again', 1).click())
  expect(programs.login).toHaveBeenCalledWith('claude', { accountId: ids[1] })
  const routing = container.querySelector<HTMLSelectElement>(
    '[aria-label="Claude account routing"]',
  )!
  act(() => {
    routing.value = 'specific'
    routing.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(settings.change).toHaveBeenCalledWith({
    type: 'claude.routing',
    mode: 'specific',
    pinnedId: ids[0],
  })
})
it('requires explicit confirmation to move a lane and blocks removal while active', async () => {
  const accounts = settings.data!.providers!.accounts
  accounts[0]!.lanes = [{ id: 'lane', title: 'Saved work', active: true }]
  render()
  expect(accountButton('Remove account').disabled).toBe(true)
  act(() => accountButton('Usage & lanes').click())
  const move = accountButton(`Move to ${accounts[1]!.label}`)
  await act(async () => move.click())
  expect(settings.moveAccount).not.toHaveBeenCalled()
  vi.mocked(promptChoice).mockResolvedValue('move')
  await act(async () => move.click())
  expect(settings.moveAccount).toHaveBeenCalledWith('lane', accounts[1]!.id)
  expect(promptChoice).toHaveBeenLastCalledWith(
    expect.objectContaining({ title: 'Move Saved work on bee?' }),
  )
})
