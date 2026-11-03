// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { useSettingsUiStore } from '../../settingsUiStore'
import { HostSubagents, LocalSubagents } from './index'

vi.mock('../../ConfigFileEditor', () => ({
  piConfigFile: (name: string) => ({ key: name }),
  ConfigFileEditor: ({ source }: { source: { key: string } }) => <div data-editor={source.key} />,
}))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Subagents settings', () => {
  it('explains ownership and reuses the settings editor and directives navigation', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    try {
      await act(async () => root.render(<LocalSubagents />))
      expect(container.textContent).toContain('Pi owns execution')
      expect(container.textContent).toContain('not acceptance')
      expect(container.textContent).toContain('Neither is a security sandbox')
      const button = (label: string) =>
        [...container.querySelectorAll('button')].find((b) => b.textContent === label)!
      act(() => button('Edit global settings…').click())
      expect(container.querySelector('[data-editor="settings"]')).not.toBeNull()
      act(() => button('Open directives').click())
      expect(useSettingsUiStore.getState()).toMatchObject({
        tab: 'agent',
        reveal: { title: 'Sub-agent policy' },
      })
    } finally {
      act(() => root.unmount())
    }
  })

  it('keeps the guide on a Host but offers no raw editor there', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    try {
      await act(async () => root.render(<HostSubagents />))
      expect(container.textContent).toContain('Pi owns execution')
      expect(container.textContent).toContain('Pi settings')
      expect(container.textContent).not.toContain('Edit global settings…')
    } finally {
      act(() => root.unmount())
    }
  })

  it.each([
    ['a Host, whose directives only the machine has', <HostSubagents key="host" />, null],
    ['This Mac, whose folders keep their own', <LocalSubagents key="local" />, '/work/app'],
  ])('opens the directives from folder scope on %s (regression R-U10)', async (_, view, folder) => {
    const container = document.createElement('div')
    const root = createRoot(container)
    try {
      useSettingsUiStore.getState().setFolder('/work/app')
      await act(async () => root.render(view))
      const open = [...container.querySelectorAll('button')].find(
        (b) => b.textContent === 'Open directives',
      )!
      act(() => open.click())
      expect(useSettingsUiStore.getState()).toMatchObject({
        tab: 'agent',
        folder,
        reveal: { title: 'Sub-agent policy' },
      })
    } finally {
      act(() => root.unmount())
      useSettingsUiStore.getState().setFolder(null)
    }
  })
})
