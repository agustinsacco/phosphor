// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useSettingsUiStore } from '../settingsUiStore'
import { ScopeRow } from './ScopeRow'

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useSettingsUiStore.setState({ folder: null })
  vi.unstubAllGlobals()
})

it('names a chosen folder that left the list as removed (regression R-U11)', () => {
  useSettingsUiStore.setState({ folder: '0000000000000002' })
  act(() => root.render(<ScopeRow folders={[{ value: '0000000000000001', label: 'Phosphor' }]} />))
  const options = [...container.querySelectorAll('option')].map((option) => option.textContent)
  expect(options).toEqual(['Phosphor', 'Removed folder (0000000000000002)'])
})
