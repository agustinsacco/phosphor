// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { EXTENSION_TABS, TABS } from '../settingsIndex'
import { SETTINGS_SECTIONS } from './registry'

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  })
})
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))

describe('the section registry', () => {
  it.each([...TABS, ...EXTENSION_TABS].map((section) => [section.id, section] as const))(
    '%s renders exactly where the navigation lists it',
    (_, section) => {
      const views = SETTINGS_SECTIONS[section.id]
      expect(!!views.Device).toBe(section.scope === 'device')
      expect(!!views.Local).toBe(section.local === true)
      expect(!!views.Host).toBe(section.host !== undefined)
    },
  )

  it('scopes only the sections a folder can configure', () => {
    const scoped = Object.entries(SETTINGS_SECTIONS)
      .filter(([, views]) => views.scoped)
      .map(([id]) => id)
    expect(scoped).toEqual(['agent', 'extensions', 'connectors'])
  })
})
