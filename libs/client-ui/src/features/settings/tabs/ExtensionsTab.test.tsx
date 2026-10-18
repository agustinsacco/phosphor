// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PiPackageEntry } from '@shared/models'
import { useLayoutStore } from '@/stores/layout'
import { useSettingsUiStore } from '../settingsUiStore'
import { ExtensionsTab } from './ExtensionsTab'

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const subagents: PiPackageEntry = {
  spec: 'npm:pi-subagents',
  scope: 'global',
  kind: 'npm',
  filtered: false,
  name: 'pi-subagents',
  version: '0.74.0',
  installed: true,
  resources: {
    extensions: ['index.js'],
    skills: ['council-mode', 'pi-subagents'],
    prompts: ['council', 'review-loop'],
    themes: [],
  },
}

const invoke = vi.fn(async (channel: string) => {
  switch (channel) {
    case 'packages:list':
      return [subagents]
    case 'packages:detect':
      return { claude: false }
    case 'packages:checkUpdates':
      return {}
    default:
      return null
  }
})

beforeEach(() => {
  ;(globalThis as unknown as { window: { phosphor: unknown } }).window.phosphor = {
    invoke,
    onPackagesJobOutput: () => () => {},
    onPackagesJobExit: () => () => {},
  }
})

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  document.body.innerHTML = ''
})

async function render(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(<ExtensionsTab />))
  await vi.waitFor(() => expect(document.querySelector('dl')).not.toBeNull())
}

describe('ExtensionsTab', () => {
  it('lists what each package contributes, by name', async () => {
    await render()
    const rows = [...document.querySelectorAll('dl > div')].map((row) => row.textContent)
    expect(rows).toEqual([
      'Skills (2)council-mode, pi-subagentsView in Skills',
      'Prompts (2)/council, /review-loop',
      'Extensions (1)index.js',
    ])
  })

  it('jumps from a package’s skills to the Skills page', async () => {
    useSettingsUiStore.getState().setOpen(true)
    await render()
    const button = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'View in Skills',
    )!
    act(() => button.click())
    expect(useSettingsUiStore.getState().open).toBe(false)
    expect(useLayoutStore.getState().page).toBe('skills')
  })
})
