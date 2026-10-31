// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mockSettingsRead } from '@/dev/mockMachineSettings'
import { MachineAdvancedSettings } from './MachineAdvancedSettings'
import type { MachinePrograms } from './MachineProviderSettings'
import type { HostSettingsState } from './useHostSettings'

let root: Root, container: HTMLDivElement
let programs: MachinePrograms
const settings = {
  data: mockSettingsRead('advanced-test', 'advanced'),
} as unknown as HostSettingsState
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
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
function update(): HTMLButtonElement {
  act(() =>
    root.render(<MachineAdvancedSettings label="bee" settings={settings} programs={programs} />),
  )
  const button = [...container.querySelectorAll('button')].find(
    (entry) => entry.textContent?.trim() === 'Pause and update',
  )
  if (!button) throw new Error('Missing Pause and update')
  return button
}

it('asks the Host to pause and update itself through its fixed-purpose task', () => {
  act(() => update().click())
  expect(programs.task).toHaveBeenCalledWith({ task: 'host.update' })
  expect(container.textContent).toContain('Host updates')
})

it('offers no update while a private Host program cannot run', () => {
  programs = { ...programs, available: false }
  expect(update().disabled).toBe(true)
  programs = { ...programs, available: true, busy: true }
  expect(update().disabled).toBe(true)
})
