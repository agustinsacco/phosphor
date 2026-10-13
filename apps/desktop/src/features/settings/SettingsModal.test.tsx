// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SettingsModal } from './SettingsModal'
import { useSettingsUiStore } from './settingsUiStore'
import { useFeedbackStore } from '@/features/feedback/feedbackStore'
vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  })
})
vi.mock('./tabs/AppearanceTab', () => ({ AppearanceTab: () => <p>Appearance</p> }))
vi.mock('./tabs/AgentTab', () => ({ AgentTab: () => null }))
vi.mock('./tabs/AccountsTab', () => ({ AccountsTab: () => null }))
vi.mock('./tabs/ExtensionsTab', () => ({ ExtensionsTab: () => null }))
vi.mock('./tabs/ClaudeProviderTab', () => ({ ClaudeProviderTab: () => null }))
vi.mock('./tabs/WebAccessTab', () => ({ WebAccessTab: () => null }))
vi.mock('./tabs/WorkspacesTab', () => ({ WorkspacesTab: () => null }))
vi.mock('./tabs/OptimizationTab', () => ({ OptimizationTab: () => null }))
vi.mock('./tabs/AdvancedTab', () => ({ AdvancedTab: () => null }))
vi.mock('./tabs/ConnectorsTab', () => ({ ConnectorsTab: () => null }))
vi.mock('./tabs/ComputerUseTab', () => ({ ComputerUseTab: () => null }))
vi.mock('./tabs/SubagentsTab', () => ({ SubagentsTab: () => null }))
vi.mock('./tabs/AboutTab', () => ({ AboutTab: () => null }))
let root: Root
let container: HTMLDivElement
const invoke = vi.fn(async (channel: string) =>
  channel === 'packages:list'
    ? []
    : channel === 'feedback:state'
      ? { mode: 'github', repo: 'agustinsacco/Phosphor', nudge: false }
      : undefined,
)
beforeEach(() => {
  invoke.mockClear()
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: () => undefined,
  })
  vi.stubGlobal('phosphor', { invoke, platform: 'darwin' })
  useSettingsUiStore.setState({ open: true, tab: 'appearance', reveal: null })
  useFeedbackStore.setState({ open: false, state: null })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
it('keeps Send feedback in the Settings footer and opens the same form', async () => {
  await act(async () => root.render(<SettingsModal />))
  const footer = document.querySelector('[data-testid=settings-footer]')
  expect(footer?.textContent).toContain('Send feedback')
  const button = footer?.querySelector<HTMLButtonElement>('[data-testid=feedback-button]')
  expect(button?.dataset.nudge).toBe('false')
  act(() => button?.click())
  expect(useFeedbackStore.getState().open).toBe(true)
})
it('preserves the one-time nudge and dismisses it without opening feedback', async () => {
  await act(async () => root.render(<SettingsModal />))
  act(() =>
    useFeedbackStore.setState({
      state: { mode: 'github', repo: 'agustinsacco/Phosphor', nudge: true },
    }),
  )
  const footer = document.querySelector('[data-testid=settings-footer]')
  expect(footer?.querySelector<HTMLElement>('[data-testid=feedback-button]')?.dataset.nudge).toBe(
    'true',
  )
  expect(footer?.textContent).toContain('How is Phosphor going?')
  await act(async () => footer?.querySelector<HTMLButtonElement>('[aria-label=Dismiss]')?.click())
  expect(invoke).toHaveBeenCalledWith('feedback:dismiss')
  expect(footer?.textContent).toContain('Send feedback')
  expect(useFeedbackStore.getState().open).toBe(false)
})
